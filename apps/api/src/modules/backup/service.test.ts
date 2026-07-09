import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'

process.env['DATABASE_URL'] ??=
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'
process.env['VAULT_ALLOW_REMOTE_INIT'] = 'true'
process.env['BACKUP_DATABASE_URL'] ??= 'postgresql://postgres:password@localhost:5432/project_vault'
process.env['BACKUP_RETENTION_COUNT'] = '2'
const storageDir = mkdtempSync(join(tmpdir(), 'backup-service-test-'))
process.env['BACKUP_STORAGE_PATH'] = storageDir

const { initVault, loadInitialVaultState } = await import('../vault/key-service.js')
const { resetVaultForTest } = await import('../../__tests__/helpers/vault-test-cleanup.js')
const { getDb } = await import('@project-vault/db')
const { backupRuns } = await import('@project-vault/db/schema')
const { eq } = await import('drizzle-orm')
const {
  acquireBackupSlot,
  executeBackupSnapshot,
  listBackups,
  restoreFromBackup,
  validateBackupFile,
  pruneOldBackups,
} = await import('./service.js')
const { backupStorageFor } = await import('./storage.js')

const TEST_PASSPHRASE = 'backup-service-test-passphrase'
const FAKE_DUMP_SQL = Buffer.from(`
CREATE TABLE "organizations" (id uuid);
CREATE TABLE "users" (id uuid);
CREATE TABLE "projects" (id uuid);
CREATE TABLE "credentials" (id uuid);
CREATE TABLE "audit_log_entries" (id uuid);
CREATE TABLE "data_erasure_requests" (id uuid);
`)

async function fakeDump(): Promise<Buffer> {
  return FAKE_DUMP_SQL
}

async function failingDump(): Promise<Buffer> {
  throw new Error('pg_dump: connection to server at "db" failed')
}

function testStorage() {
  return backupStorageFor({ type: 'filesystem', path: storageDir })
}

const EXPECTED_OK_MESSAGE = 'expected ok'

async function reinitVault(): Promise<void> {
  await resetVaultForTest()
  try {
    await initVault({ kmsType: 'passphrase', passphrase: TEST_PASSPHRASE }, {})
  } catch (error) {
    if ((error as { code?: string }).code !== 'ALREADY_INITIALIZED') throw error
  }
}

afterAll(async () => {
  await resetVaultForTest()
  rmSync(storageDir, { recursive: true, force: true })
})

describe.sequential('Story 9.1: backup service', () => {
  beforeAll(async () => {
    await reinitVault()
  })

  it('AC-7: acquireBackupSlot rejects a concurrent trigger while one is already running', async () => {
    const first = await acquireBackupSlot({ triggeredBy: 'manual' })
    expect(first.ok).toBe(true)
    if (!first.ok) throw new Error(EXPECTED_OK_MESSAGE)

    const second = await acquireBackupSlot({ triggeredBy: 'manual' })
    expect(second.ok).toBe(false)
    if (second.ok) throw new Error('expected conflict')
    expect(second.jobId).toBe(first.runId)

    // Clean up: mark the first run as failed so it stops blocking later tests in this file.
    await getDb().update(backupRuns).set({ status: 'failed' }).where(eq(backupRuns.id, first.runId))
  })

  it('AC-5: executeBackupSnapshot produces a decryptable file with a matching checksum', async () => {
    const slot = await acquireBackupSlot({ triggeredBy: 'manual' })
    expect(slot.ok).toBe(true)
    if (!slot.ok) throw new Error(EXPECTED_OK_MESSAGE)

    const storage = testStorage()
    const result = await executeBackupSnapshot(
      { runId: slot.runId, filename: slot.filename, metaFilename: slot.metaFilename },
      { dump: fakeDump, storage }
    )
    expect(result.sizeBytes).toBeGreaterThan(0)

    const [row] = await getDb().select().from(backupRuns).where(eq(backupRuns.id, slot.runId))
    expect(row?.status).toBe('succeeded')
    expect(row?.checksumSha256).toBe(result.checksumSha256)
    expect(row?.sizeBytes).toBe(result.sizeBytes)

    const validated = await validateBackupFile(slot.filename, { storage })
    expect(validated.valid).toBe(true)
    expect(validated.checksumMatches).toBe(true)
    expect(validated.assetsPresent).toEqual({
      credentials: true,
      projects: true,
      users: true,
      auditEvents: true,
      dataErasureRequests: true,
    })
  })

  it('AC-5 negative: pg_dump failure marks the run failed with an error message, and rethrows', async () => {
    const slot = await acquireBackupSlot({ triggeredBy: 'manual' })
    expect(slot.ok).toBe(true)
    if (!slot.ok) throw new Error(EXPECTED_OK_MESSAGE)

    const storage = testStorage()
    await expect(
      executeBackupSnapshot(
        { runId: slot.runId, filename: slot.filename, metaFilename: slot.metaFilename },
        { dump: failingDump, storage }
      )
    ).rejects.toThrow(/pg_dump/)

    const [row] = await getDb().select().from(backupRuns).where(eq(backupRuns.id, slot.runId))
    expect(row?.status).toBe('failed')
    expect(row?.errorMessage).toMatch(/pg_dump/)
  })

  it('AC-6 negative: an S3 upload failure marks the run failed without leaking any credential material', async () => {
    const { backupStorageFor } = await import('./storage.js')
    const slot = await acquireBackupSlot({ triggeredBy: 'manual' })
    if (!slot.ok) throw new Error(EXPECTED_OK_MESSAGE)

    const unreachableS3Storage = backupStorageFor({
      type: 's3',
      bucket: 'unreachable-test-bucket',
      endpoint: 'http://127.0.0.1:1',
      region: 'us-east-1',
    })

    await expect(
      executeBackupSnapshot(
        { runId: slot.runId, filename: slot.filename, metaFilename: slot.metaFilename },
        { dump: fakeDump, storage: unreachableS3Storage }
      )
    ).rejects.toThrow()

    const [row] = await getDb().select().from(backupRuns).where(eq(backupRuns.id, slot.runId))
    expect(row?.status).toBe('failed')
    // No AWS secret/access key is ever passed into our S3Client config in the first place (D-less
    // by construction), but assert the stored message never contains an obvious credential marker.
    expect(row?.errorMessage ?? '').not.toMatch(/aws_secret|accessKeyId|secretAccessKey/i)
  })

  it('AC-8: listBackups returns most-recent-first and includes a failed run with sizeBytes null', async () => {
    const items = await listBackups()
    expect(items.length).toBeGreaterThanOrEqual(2)
    const anyFailed = items.some((i) => i.sizeBytes === null)
    expect(anyFailed).toBe(true)
    // most-recent-first ordering
    const timestamps = items.map((i) => new Date(i.timestamp).getTime())
    expect([...timestamps].sort((a, b) => b - a)).toEqual(timestamps)
  })

  it('D2.2: listBackups items include status and errorMessage fields', async () => {
    const items = await listBackups()
    expect(items.length).toBeGreaterThanOrEqual(1)
    for (const item of items) {
      expect(['running', 'succeeded', 'failed']).toContain(item.status)
      expect(item.errorMessage === null || typeof item.errorMessage === 'string').toBe(true)
    }
    const failedItem = items.find((i) => i.sizeBytes === null)
    expect(failedItem).toBeDefined()
    expect(failedItem?.status).toBe('failed')
  })

  it('AC-9: restore verifies checksum, decrypts, restores, then seals the vault', async () => {
    await reinitVault()

    const slot = await acquireBackupSlot({ triggeredBy: 'manual' })
    if (!slot.ok) throw new Error(EXPECTED_OK_MESSAGE)
    const storage = testStorage()
    await executeBackupSnapshot(
      { runId: slot.runId, filename: slot.filename, metaFilename: slot.metaFilename },
      { dump: fakeDump, storage }
    )

    let restoreCalledWithSql: Buffer | undefined
    const outcome = await restoreFromBackup(slot.filename, {
      storage,
      restore: async (_url, sql) => {
        restoreCalledWithSql = sql
      },
    })
    expect(outcome.code).toBe('restored')
    expect(restoreCalledWithSql?.toString('utf8')).toContain('CREATE TABLE "users"')

    // AC-9: vault sealed after restore — getVaultStatus reflects this immediately.
    const { getVaultStatus } = await import('../vault/key-service.js')
    expect(getVaultStatus()).toBe('sealed')
    await loadInitialVaultState()
  })

  it('AC-9 negative: checksum mismatch is detected before any restore call, and no restore happens', async () => {
    await reinitVault()

    const slot = await acquireBackupSlot({ triggeredBy: 'manual' })
    if (!slot.ok) throw new Error(EXPECTED_OK_MESSAGE)
    const storage = testStorage()
    await executeBackupSnapshot(
      { runId: slot.runId, filename: slot.filename, metaFilename: slot.metaFilename },
      { dump: fakeDump, storage }
    )

    // Tamper the stored file after the fact so its real checksum no longer matches the sidecar.
    const tampered = await storage.read(slot.filename)
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff
    await storage.write(slot.filename, tampered)

    let restoreCalled = false
    const outcome = await restoreFromBackup(slot.filename, {
      storage,
      restore: async () => {
        restoreCalled = true
      },
    })
    expect(outcome.code).toBe('checksum_mismatch')
    expect(restoreCalled).toBe(false)
  })

  it('AC-9 negative: unknown filename returns not_found', async () => {
    const storage = testStorage()
    const outcome = await restoreFromBackup(`nonexistent-${randomUUID()}.vault`, { storage })
    expect(outcome.code).toBe('not_found')
  })

  it('AC-9 negative: a checksum-matching but wrong-key-encrypted file returns decrypt_failed (401, no oracle)', async () => {
    // Simulates restoring a backup encrypted under a rotated-away master key (AC-9's literal
    // example) — the checksum in the sidecar still matches the file (nothing was tampered after
    // the fact), but decryption fails because the current getBackupKey() is not the key it was
    // encrypted with.
    const { runBackupCrypto } = await import('@project-vault/crypto')
    const { createHash, randomBytes } = await import('node:crypto')
    const storage = testStorage()
    // Must match the real backup filename pattern (`FILENAME_PATTERN` in filename.ts) — the
    // code-review path-traversal fix in restoreFromBackup/validateBackupFile now rejects any
    // filename that doesn't look like a genuine backup file before ever reaching storage/decrypt.
    const filename = `backup_20260101T000000000Z_${randomUUID()}.vault`
    const metaFilename = filename.replace(/\.vault$/, '.meta.json')

    const wrongKey = randomBytes(32)
    const encryptedUnderWrongKey = await runBackupCrypto('encrypt', FAKE_DUMP_SQL, wrongKey)
    const checksumSha256 = createHash('sha256').update(encryptedUnderWrongKey).digest('hex')

    await storage.write(filename, encryptedUnderWrongKey)
    await storage.write(metaFilename, Buffer.from(JSON.stringify({ checksumSha256 })))

    const outcome = await restoreFromBackup(filename, { storage })
    expect(outcome.code).toBe('decrypt_failed')
  })

  it('AC-10 negative: validate reports invalid without throwing for a corrupted file', async () => {
    const storage = testStorage()
    const outcome = await validateBackupFile(`corrupted-${randomUUID()}.vault`, { storage })
    expect(outcome.valid).toBe(false)
    expect(outcome.assetsPresent).toEqual({
      credentials: false,
      projects: false,
      users: false,
      auditEvents: false,
      dataErasureRequests: false,
    })
  })

  it('AC-11: retention pruning keeps only BACKUP_RETENTION_COUNT succeeded backups, deletes the rest', async () => {
    await reinitVault()
    const storage = testStorage()

    // This file has already produced at least 3 succeeded backups above (AC-5, AC-9, AC-9
    // negative) — BACKUP_RETENTION_COUNT=2 (set at the top of this file) guarantees pruning has
    // something to do even before adding more.
    const slot = await acquireBackupSlot({ triggeredBy: 'manual' })
    if (!slot.ok) throw new Error(EXPECTED_OK_MESSAGE)
    await executeBackupSnapshot(
      { runId: slot.runId, filename: slot.filename, metaFilename: slot.metaFilename },
      { dump: fakeDump, storage }
    )

    const succeededBefore = await getDb()
      .select({ id: backupRuns.id })
      .from(backupRuns)
      .where(eq(backupRuns.status, 'succeeded'))
    expect(succeededBefore.length).toBeGreaterThan(2)

    const { prunedFilenames } = await pruneOldBackups({ storage })
    expect(prunedFilenames.length).toBeGreaterThan(0)

    // Rows are retained (AC-11's documented choice) — only the physical files are removed.
    const succeededAfter = await getDb()
      .select({ id: backupRuns.id })
      .from(backupRuns)
      .where(eq(backupRuns.status, 'succeeded'))
    expect(succeededAfter.length).toBe(succeededBefore.length)

    for (const filename of prunedFilenames) {
      await expect(storage.read(filename)).rejects.toThrow()
    }
    // The most recent backup (just created) must never be among the pruned set.
    expect(prunedFilenames).not.toContain(slot.filename)
  })

  it('AC-11 edge: a still-running backup is never eligible for pruning, even if it is the oldest row', async () => {
    await reinitVault()
    const storage = testStorage()

    // A running row with an old startedAt would sort as "oldest" if pruning ever considered
    // non-succeeded rows — pruneOldBackups must filter to status='succeeded' before ranking by
    // recency, so this row must survive regardless of how old it looks.
    const [runningRow] = await getDb()
      .insert(backupRuns)
      .values({
        filename: `backup_still-running-${randomUUID()}.vault`,
        status: 'running',
        triggeredBy: 'manual',
        startedAt: new Date('2000-01-01T00:00:00.000Z'),
      })
      .returning({ id: backupRuns.id })
    if (!runningRow) throw new Error(EXPECTED_OK_MESSAGE)

    const { prunedFilenames } = await pruneOldBackups({ storage })

    const [afterRow] = await getDb()
      .select()
      .from(backupRuns)
      .where(eq(backupRuns.id, runningRow.id))
    expect(afterRow?.status).toBe('running')
    expect(prunedFilenames).not.toContain(afterRow?.filename)

    // Clean up so this synthetic row doesn't block AC-7-style "already running" checks in other
    // test files sharing this database.
    await getDb()
      .update(backupRuns)
      .set({ status: 'failed' })
      .where(eq(backupRuns.id, runningRow.id))
  })
})
