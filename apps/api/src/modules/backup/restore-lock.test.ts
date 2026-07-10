import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'

process.env['DATABASE_URL'] ??=
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'
process.env['VAULT_ALLOW_REMOTE_INIT'] = 'true'
process.env['BACKUP_DATABASE_URL'] ??= 'postgresql://postgres:password@localhost:5432/project_vault'
const storageDir = mkdtempSync(join(tmpdir(), 'restore-lock-test-'))
process.env['BACKUP_STORAGE_PATH'] = storageDir

const { initVault } = await import('../vault/key-service.js')
const { resetVaultForTest } = await import('../../__tests__/helpers/vault-test-cleanup.js')
const { getDb, reserveConnection, withOrg } = await import('@project-vault/db')
const { withTestOrg } = await import('@project-vault/db/test-helpers')
const { backupRuns } = await import('@project-vault/db/schema')
const { eq, sql } = await import('drizzle-orm')
const { acquireBackupSlot, acquireRestoreLock, restoreFromBackup, executeBackupSnapshot } =
  await import('./service.js')
const { backupStorageFor } = await import('./storage.js')

const BACKUP_ADVISORY_LOCK_KEY = 'backup/snapshot'
const FAKE_DUMP_SQL = Buffer.from('CREATE TABLE "users" (id uuid);')
const EXPECTED_OK_MESSAGE = 'expected ok'

function testStorage() {
  return backupStorageFor({ type: 'filesystem', path: storageDir })
}

// Lock + unlock MUST run on the exact same physical connection (session-scoped state) — using
// getDb()'s pooled connection here would risk the lock and unlock statements landing on two
// different connections, silently leaking the lock onto whichever connection acquired it. This is
// exactly the hazard D1 documents; the probe itself must use a reserved connection too.
async function probeLockFree(): Promise<boolean> {
  const reserved = await reserveConnection()
  try {
    const [lockRow] = await reserved<{ locked: boolean }[]>`
      SELECT pg_try_advisory_lock(hashtext(${BACKUP_ADVISORY_LOCK_KEY})) AS locked
    `
    const locked = Boolean(lockRow?.locked)
    if (locked) {
      await reserved`SELECT pg_advisory_unlock(hashtext(${BACKUP_ADVISORY_LOCK_KEY}))`
    }
    return locked
  } finally {
    reserved.release()
  }
}

async function insertRunningBackupRow(): Promise<string> {
  // triggeredBy: 'manual' (not 'schedule') — this is a synthetic row only standing in for "a
  // dump is in flight" (AC-3 doesn't care which trigger started it); backup-snapshot.test.ts's
  // own scheduled-fire test queries backup_runs filtered on triggeredBy='schedule' with no
  // orderBy/limit, so leaving a 'schedule'-triggered row behind (even failed/cleaned-up) in this
  // shared test database would risk that unrelated test picking up the wrong row.
  const [row] = await getDb()
    .insert(backupRuns)
    .values({
      filename: `backup_inflight-${randomUUID()}.vault`,
      status: 'running',
      triggeredBy: 'manual',
    })
    .returning({ id: backupRuns.id })
  if (!row) throw new Error('expected inserted row')
  return row.id
}

async function clearRunningRow(id: string): Promise<void> {
  await getDb().update(backupRuns).set({ status: 'failed' }).where(eq(backupRuns.id, id))
}

describe.sequential('Story 9.6 D1: acquireRestoreLock', () => {
  beforeAll(async () => {
    await resetVaultForTest()
    try {
      await initVault({ kmsType: 'passphrase', passphrase: 'restore-lock-test-passphrase' }, {})
    } catch (error) {
      if ((error as { code?: string }).code !== 'ALREADY_INITIALIZED') throw error
    }
  })

  afterAll(async () => {
    await resetVaultForTest()
    rmSync(storageDir, { recursive: true, force: true })
  })

  it('AC-1: acquires the lock when nothing else holds it, and release() frees it again', async () => {
    const result = await acquireRestoreLock()
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(EXPECTED_OK_MESSAGE)

    // Lock is genuinely held: a fresh probe from a separate connection must fail to acquire it.
    expect(await probeLockFree()).toBe(false)

    await result.release()

    // Released: the probe now succeeds.
    expect(await probeLockFree()).toBe(true)
  })

  it('AC-2/D1: a second acquireRestoreLock() call fails with restore_in_progress while the first still holds it', async () => {
    const first = await acquireRestoreLock()
    expect(first.ok).toBe(true)
    if (!first.ok) throw new Error(EXPECTED_OK_MESSAGE)

    const second = await acquireRestoreLock()
    expect(second).toEqual({ ok: false, reason: 'restore_in_progress' })

    await first.release()
    expect(await probeLockFree()).toBe(true)
  })

  it('AC-3: rejects with backup_in_progress when a backup_runs row is already running, and releases the session lock it had just acquired', async () => {
    const runningId = await insertRunningBackupRow()
    try {
      const result = await acquireRestoreLock()
      expect(result).toEqual({ ok: false, reason: 'backup_in_progress' })

      // The session lock acquired during the check must have been released, not leaked.
      expect(await probeLockFree()).toBe(true)
    } finally {
      await clearRunningRow(runningId)
    }
  })

  it('D1.11 (adversarial review, high): the post-lock backup_runs check still finds a running row when invoked inside an org-scoped withOrg() context (RLS is not silently filtering backup_runs)', async () => {
    const runningId = await insertRunningBackupRow()
    try {
      await withTestOrg(async ({ orgId }) => {
        const result = await withOrg(orgId, async () => acquireRestoreLock())
        expect(result).toEqual({ ok: false, reason: 'backup_in_progress' })
      })
      expect(await probeLockFree()).toBe(true)
    } finally {
      await clearRunningRow(runningId)
    }
  })

  it('AC-4: acquireBackupSlot is blocked while acquireRestoreLock holds the session lock (zero changes to acquireBackupSlot)', async () => {
    const lock = await acquireRestoreLock()
    expect(lock.ok).toBe(true)
    if (!lock.ok) throw new Error(EXPECTED_OK_MESSAGE)

    const slot = await acquireBackupSlot({ triggeredBy: 'manual' })
    expect(slot.ok).toBe(false)

    await lock.release()
  })

  it('AC-6b/D1.4 (critical fix): an exception thrown by the post-lock backup_runs check still releases the lock before propagating', async () => {
    const boom = new Error('simulated transient DB error during the post-lock check')
    await expect(
      acquireRestoreLock(undefined, {
        checkBackupRunning: async () => {
          throw boom
        },
      })
    ).rejects.toThrow(boom)

    expect(await probeLockFree()).toBe(true)
  })

  it('AC-6: the lock is released after every restore outcome when the caller wraps restoreFromBackup in try/finally (mirrors routes.ts wiring)', async () => {
    await resetVaultForTest()
    await initVault({ kmsType: 'passphrase', passphrase: 'restore-lock-test-passphrase-2' }, {})

    const storage = testStorage()
    const slot = await acquireBackupSlot({ triggeredBy: 'manual' })
    if (!slot.ok) throw new Error('expected slot')
    await executeBackupSnapshot(
      { runId: slot.runId, filename: slot.filename, metaFilename: slot.metaFilename },
      { dump: async () => FAKE_DUMP_SQL, storage }
    )

    // checksum_mismatch fixture: a second succeeded backup, tampered after the fact so its stored
    // checksum no longer matches its sidecar.
    const tamperedSlot = await acquireBackupSlot({ triggeredBy: 'manual' })
    if (!tamperedSlot.ok) throw new Error('expected slot')
    await executeBackupSnapshot(
      {
        runId: tamperedSlot.runId,
        filename: tamperedSlot.filename,
        metaFilename: tamperedSlot.metaFilename,
      },
      { dump: async () => FAKE_DUMP_SQL, storage }
    )
    const tampered = await storage.read(tamperedSlot.filename)
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff
    await storage.write(tamperedSlot.filename, tampered)

    // decrypt_failed fixture: a checksum-matching file encrypted under a different key.
    const { runBackupCrypto } = await import('@project-vault/crypto')
    const { createHash, randomBytes } = await import('node:crypto')
    const wrongKeyFilename = `backup_20260101T000000000Z_${randomUUID()}.vault`
    const wrongKeyMetaFilename = wrongKeyFilename.replace(/\.vault$/, '.meta.json')
    const wrongKey = randomBytes(32)
    const encryptedUnderWrongKey = await runBackupCrypto('encrypt', FAKE_DUMP_SQL, wrongKey)
    const wrongKeyChecksum = createHash('sha256').update(encryptedUnderWrongKey).digest('hex')
    await storage.write(wrongKeyFilename, encryptedUnderWrongKey)
    await storage.write(
      wrongKeyMetaFilename,
      Buffer.from(JSON.stringify({ checksumSha256: wrongKeyChecksum }))
    )

    const scenarios: Array<{
      label: string
      filename: string
      restore?: (url: string, sql: Buffer) => Promise<void>
      expectedCode: string
    }> = [
      {
        label: 'not_found',
        filename: `nonexistent-${randomUUID()}.vault`,
        expectedCode: 'not_found',
      },
      {
        label: 'checksum_mismatch',
        filename: tamperedSlot.filename,
        expectedCode: 'checksum_mismatch',
      },
      {
        label: 'decrypt_failed',
        filename: wrongKeyFilename,
        expectedCode: 'decrypt_failed',
      },
      {
        label: 'restore_failed',
        filename: slot.filename,
        restore: async () => {
          throw new Error('simulated psql restore failure')
        },
        expectedCode: 'restore_failed',
      },
      // 'restored' must run LAST — restoreFromBackup seals the vault (zeroKeys()) on this
      // outcome only, so any scenario after it would need the vault re-unsealed first.
      {
        label: 'restored',
        filename: slot.filename,
        restore: async () => {
          /* no-op stub — proves the lock-release wrapper runs on the happy path too */
        },
        expectedCode: 'restored',
      },
    ]

    for (const scenario of scenarios) {
      const lock = await acquireRestoreLock()
      expect(lock.ok).toBe(true)
      if (!lock.ok) throw new Error(EXPECTED_OK_MESSAGE)
      try {
        const outcome = await restoreFromBackup(scenario.filename, {
          storage,
          ...(scenario.restore ? { restore: scenario.restore } : {}),
        })
        expect(outcome.code).toBe(scenario.expectedCode)
      } finally {
        await lock.release()
      }
      expect(await probeLockFree()).toBe(true)
    }
  })

  it('AC-7: PostgreSQL releases the session-level advisory lock automatically when the holding connection is terminated (crash simulation) — no application-level reconciliation needed', async () => {
    const reserved = await reserveConnection()
    const [pidRow] = await reserved<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`
    const pid = pidRow?.pid
    expect(pid).toBeTypeOf('number')

    const [lockRow] = await reserved<{ locked: boolean }[]>`
      SELECT pg_try_advisory_lock(hashtext(${BACKUP_ADVISORY_LOCK_KEY})) AS locked
    `
    expect(lockRow?.locked).toBe(true)

    // Simulate a crash: terminate the backend directly — no pg_advisory_unlock call, no
    // reserved.release() — PostgreSQL itself is responsible for releasing this session's
    // advisory locks as part of connection teardown.
    await getDb().execute(sql`SELECT pg_terminate_backend(${pid})`)
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(await probeLockFree()).toBe(true)

    try {
      reserved.release()
    } catch {
      // Expected: the underlying connection is already gone (that's the point of this test).
    }
  })
})
