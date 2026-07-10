import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'

process.env['DATABASE_URL'] ??=
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'
process.env['VAULT_ALLOW_REMOTE_INIT'] = 'true'
process.env['BACKUP_DATABASE_URL'] ??= 'postgresql://postgres:password@localhost:5432/project_vault'
const originalRateLimitTestBypass = process.env['RATE_LIMIT_TEST_BYPASS']
// This suite exercises backup behavior, not throttling. Its shared operator makes more than five
// restore requests, so production rate limiting would mask the lock and operational-log outcomes.
process.env['RATE_LIMIT_TEST_BYPASS'] = 'true'
const storageDir = mkdtempSync(join(tmpdir(), 'backup-routes-test-'))
process.env['BACKUP_STORAGE_PATH'] = storageDir

const { createApp } = await import('../../app.js')
const { initVault } = await import('../vault/key-service.js')
const { resetVaultForTest } = await import('../../__tests__/helpers/vault-test-cleanup.js')
const { registerAndLoginViaApi, cookieHeader, assertRoutesFailClosedWhileSealed } =
  await import('../../__tests__/helpers/auth-test-helpers.js')
const { createLogCaptureStream, flushCapturedLogger, parseCapturedLogLines } =
  await import('../../__tests__/helpers/capture-logs.js')
const { createLoggerConfig } = await import('../../lib/logger.js')
const { OperationalEvent } = await import('@project-vault/shared')
const { getDb, reserveConnection } = await import('@project-vault/db')
const { backupRuns, users } = await import('@project-vault/db/schema')
const { acquireBackupSlot, acquireRestoreLock, executeBackupSnapshot } =
  await import('./service.js')
const { backupStorageFor } = await import('./storage.js')

const BACKUP_ADVISORY_LOCK_KEY = 'backup/snapshot'
const EXPECTED_OK_MESSAGE = 'expected ok'

// Story 9.6 AC-6: probes ONLY the raw session-level advisory lock (not acquireRestoreLock(), which
// also checks backup_runs for a 'running' row) — narrowly scoped to what AC-6 actually asserts
// (the lock itself was released), so it can't be confused by an unrelated 'running' row some other
// test in this shared database happens to be mid-cleanup on. Lock + unlock run on the same reserved
// connection (session-scoped state).
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

const TEST_PASSPHRASE = 'backup-routes-test-passphrase'
const TRIGGER_URL = '/api/v1/admin/backup/trigger'
const BACKUPS_URL = '/api/v1/admin/backups'
const FAKE_DUMP_SQL = Buffer.from(`
CREATE TABLE "organizations" (id uuid);
CREATE TABLE "users" (id uuid);
CREATE TABLE "projects" (id uuid);
CREATE TABLE "credentials" (id uuid);
CREATE TABLE "audit_log_entries" (id uuid);
CREATE TABLE "data_erasure_requests" (id uuid);
`)

type TestApp = Awaited<ReturnType<typeof createApp>>

let app: TestApp
let operatorCookies: Record<string, string>

// Story 9.6 D1.9: parseBackupFilename()'s shape check now runs in the route handler BEFORE the
// restore lock is ever touched — a filename that doesn't match the real backup_<timestamp>_<id>
// pattern is now rejected 400 invalid_filename, never reaching storage/lock/DB. A genuinely
// well-formed-but-nonexistent filename (this helper) is what actually exercises "the file just
// isn't there" (404 backup_not_found / lock-related 409s), as intended by the original AC-9/AC-2
// fixtures below.
function wellFormedNonexistentFilename(): string {
  return `backup_20260101T000000000Z_${randomUUID()}.vault`
}

async function seedSucceededBackup(): Promise<string> {
  const slot = await acquireBackupSlot({ triggeredBy: 'manual' })
  if (!slot.ok) throw new Error('expected slot')
  const storage = backupStorageFor({ type: 'filesystem', path: storageDir })
  await executeBackupSnapshot(
    { runId: slot.runId, filename: slot.filename, metaFilename: slot.metaFilename },
    { dump: async () => FAKE_DUMP_SQL, storage }
  )
  return slot.filename
}

describe.sequential('Story 9.1: backup HTTP routes', () => {
  beforeAll(async () => {
    // This file exercises more than five restore outcomes with one authenticated operator and
    // creates a second app instance for log capture. The production limiter is process-global, so
    // both app instances intentionally share that operator+route bucket; without the documented
    // test-only bypass, unrelated restore-behavior assertions eventually receive 429 and their
    // handlers (including operational logging) never run. Rate-limit behavior has dedicated tests.
    process.env['RATE_LIMIT_TEST_BYPASS'] = 'true'
    await resetVaultForTest()
    await initVault({ kmsType: 'passphrase', passphrase: TEST_PASSPHRASE }, {})
    app = await createApp({ logger: false, vaultGuardEnabled: true })
    const result = await registerAndLoginViaApi(app, {
      email: `operator-${randomUUID()}@example.com`,
      password: 'correct-horse-battery-staple9',
      orgName: `Operator Org ${randomUUID()}`,
    })
    operatorCookies = result.cookies

    // This shared test database already has many users registered by earlier test files/runs,
    // so this registration is very unlikely to land the D1 "first user ever" bootstrap, and the
    // unique partial index (idx_users_one_platform_operator) permits at most one true row
    // database-wide — clear any existing one first, then promote this user. Mirrors AC-3's
    // documented existing-deployment upgrade path (an operator manually running `UPDATE users
    // SET is_platform_operator = true WHERE email = ...` as a one-time post-upgrade step).
    // isPlatformOperator is re-read from the DB on every request (never cached in the JWT), so
    // no fresh login is needed after this update.
    await getDb().transaction(async (tx) => {
      await tx
        .update(users)
        .set({ isPlatformOperator: false })
        .where(eq(users.isPlatformOperator, true))
      await tx.update(users).set({ isPlatformOperator: true }).where(eq(users.id, result.userId))
    })
  })

  afterAll(async () => {
    try {
      await app.close()
      await resetVaultForTest()
      rmSync(storageDir, { recursive: true, force: true })
    } finally {
      if (originalRateLimitTestBypass === undefined) {
        delete process.env['RATE_LIMIT_TEST_BYPASS']
      } else {
        process.env['RATE_LIMIT_TEST_BYPASS'] = originalRateLimitTestBypass
      }
    }
  })

  it('AC-7: POST /backup/trigger returns 202 then 409 for a concurrent trigger', async () => {
    const first = await app.inject({
      method: 'POST',
      url: TRIGGER_URL,
      headers: { cookie: cookieHeader(operatorCookies) },
    })
    expect(first.statusCode).toBe(202)
    const firstBody = first.json<{ data: { jobId: string; status: string } }>()
    expect(firstBody.data.status).toBe('running')

    const second = await app.inject({
      method: 'POST',
      url: TRIGGER_URL,
      headers: { cookie: cookieHeader(operatorCookies) },
    })
    expect(second.statusCode).toBe(409)
    expect(second.json()).toMatchObject({ code: 'backup_already_running' })

    // Clear the running row so it doesn't block subsequent tests in this file.
    await getDb()
      .update(backupRuns)
      .set({ status: 'failed' })
      .where(eq(backupRuns.id, firstBody.data.jobId))
  })

  it('AC-8: GET /backups lists backup_runs rows most-recent-first, including a filename we created', async () => {
    const filename = await seedSucceededBackup()

    const res = await app.inject({
      method: 'GET',
      url: BACKUPS_URL,
      headers: { cookie: cookieHeader(operatorCookies) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ data: { items: { filename: string }[] } }>()
    expect(body.data.items.some((item) => item.filename === filename)).toBe(true)
  })

  it('AC-8 edge: GET /backups is a well-formed empty collection, never 404, when there are no backups', async () => {
    // Not asserting a literal empty array here (this shared test DB may already have rows from
    // earlier tests in this file) — asserting the response shape/status is the meaningful,
    // order-independent check; the true "empty array" case is exercised by AC-8's own
    // service-level unit coverage in service.test.ts against a dedicated fresh DB state.
    const res = await app.inject({
      method: 'GET',
      url: BACKUPS_URL,
      headers: { cookie: cookieHeader(operatorCookies) },
    })
    expect(res.statusCode).toBe(200)
    expect(Array.isArray(res.json<{ data: { items: unknown[] } }>().data.items)).toBe(true)
  })

  it('AC-9 negative: missing confirmation returns 400 confirmation_required', async () => {
    const filename = await seedSucceededBackup()
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/backups/${filename}/restore`,
      headers: { cookie: cookieHeader(operatorCookies) },
      payload: { reason: 'oops' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'confirmation_required' })
  })

  it('AC-9 negative: unknown filename returns 404 backup_not_found', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/backups/${wellFormedNonexistentFilename()}/restore`,
      headers: { cookie: cookieHeader(operatorCookies) },
      payload: { confirmRestore: true, reason: 'test' },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ code: 'backup_not_found' })
  })

  it('AC-10: POST /backups/:filename/validate returns valid:true and updates backup_runs.verified', async () => {
    const filename = await seedSucceededBackup()

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/backups/${filename}/validate`,
      headers: { cookie: cookieHeader(operatorCookies) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<{
      data: { valid: boolean; assetsPresent: Record<string, boolean>; checksum: string }
    }>()
    expect(body.data.valid).toBe(true)
    expect(body.data.checksum).toBe('match')

    const [row] = await getDb().select().from(backupRuns).where(eq(backupRuns.filename, filename))
    expect(row?.verified).toBe('valid')
  })

  it('AC-10: validate never modifies a live table (e.g. credentials row count unchanged)', async () => {
    const filename = await seedSucceededBackup()
    const { credentials } = await import('@project-vault/db/schema')
    const before = await getDb().select({ id: credentials.id }).from(credentials)

    await app.inject({
      method: 'POST',
      url: `/api/v1/admin/backups/${filename}/validate`,
      headers: { cookie: cookieHeader(operatorCookies) },
    })

    const after = await getDb().select({ id: credentials.id }).from(credentials)
    expect(after).toHaveLength(before.length)
  })

  it('AC-10 negative: validate returns 200 with valid:false for a corrupted/unknown file (not an error status)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/backups/corrupted-${randomUUID()}.vault/validate`,
      headers: { cookie: cookieHeader(operatorCookies) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ data: { valid: boolean } }>()
    expect(body.data.valid).toBe(false)
  })

  it('AC-16: sealed vault returns 503 for all four backup/restore routes (no allow-list entry needed)', async () => {
    const filename = await seedSucceededBackup()
    const cookie = cookieHeader(operatorCookies)

    const sealedApp = await assertRoutesFailClosedWhileSealed(
      app,
      () => createApp({ logger: false, vaultGuardEnabled: true }),
      [
        { method: 'POST', url: TRIGGER_URL, headers: { cookie } },
        { method: 'GET', url: BACKUPS_URL, headers: { cookie } },
        {
          method: 'POST',
          url: `/api/v1/admin/backups/${filename}/restore`,
          headers: { cookie },
          payload: { confirmRestore: true, reason: 'test' },
        },
        {
          method: 'POST',
          url: `/api/v1/admin/backups/${filename}/validate`,
          headers: { cookie },
        },
      ]
    )
    await sealedApp.close()

    // Re-unseal + reopen the shared `app` for any subsequent test in this file.
    await initVault({ kmsType: 'passphrase', passphrase: TEST_PASSPHRASE }, {})
    app = await createApp({ logger: false, vaultGuardEnabled: true })
  })

  // Story 9.4 AC-7: platform_audit_events retrofit.
  describe('Story 9.4 AC-7: platform_audit_events retrofit', () => {
    it('backup.triggered row is written on a successful POST /backup/trigger', async () => {
      const { withPlatformOperatorContext } = await import('@project-vault/db')
      const { platformAuditEvents } = await import('@project-vault/db/schema')

      const res = await app.inject({
        method: 'POST',
        url: TRIGGER_URL,
        headers: { cookie: cookieHeader(operatorCookies) },
      })
      expect(res.statusCode).toBe(202)
      const body = res.json<{ data: { jobId: string } }>()

      const rows = await withPlatformOperatorContext((tx) =>
        tx
          .select()
          .from(platformAuditEvents)
          .where(eq(platformAuditEvents.actionType, 'backup.triggered'))
      )
      const row = rows.find((r) => (r.payload as { jobId?: string })?.jobId === body.data.jobId)
      expect(row).toBeDefined()

      await getDb()
        .update(backupRuns)
        .set({ status: 'failed' })
        .where(eq(backupRuns.id, body.data.jobId))
    })

    it('backup.restore_initiated is written even when the target filename does not exist', async () => {
      const { withPlatformOperatorContext } = await import('@project-vault/db')
      const { platformAuditEvents } = await import('@project-vault/db/schema')
      const uniqueReason = `retrofit-reason-${randomUUID()}`
      const filename = wellFormedNonexistentFilename()

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/backups/${filename}/restore`,
        headers: { cookie: cookieHeader(operatorCookies) },
        payload: { confirmRestore: true, reason: uniqueReason },
      })
      expect(res.statusCode).toBe(404)

      const rows = await withPlatformOperatorContext((tx) =>
        tx
          .select()
          .from(platformAuditEvents)
          .where(eq(platformAuditEvents.actionType, 'backup.restore_initiated'))
      )
      expect(
        rows.some(
          (r) =>
            (r.payload as { reason?: string; filename?: string })?.reason === uniqueReason &&
            (r.payload as { filename?: string })?.filename === filename
        )
      ).toBe(true)
    })

    it('backup.validated row is written on a successful POST /backups/:filename/validate', async () => {
      const { withPlatformOperatorContext } = await import('@project-vault/db')
      const { platformAuditEvents } = await import('@project-vault/db/schema')
      const filename = await seedSucceededBackup()

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/backups/${filename}/validate`,
        headers: { cookie: cookieHeader(operatorCookies) },
      })
      expect(res.statusCode).toBe(200)

      const rows = await withPlatformOperatorContext((tx) =>
        tx
          .select()
          .from(platformAuditEvents)
          .where(eq(platformAuditEvents.actionType, 'backup.validated'))
      )
      expect(rows.some((r) => (r.payload as { filename?: string })?.filename === filename)).toBe(
        true
      )
    })
  })

  // Story 9.6 D1: restore concurrency guard, wired end-to-end through the real HTTP route.
  describe('Story 9.6 D1: restore concurrency guard', () => {
    it('AC-2 (D1.9): a malformed/path-traversal filename is rejected 400 invalid_filename BEFORE the lock is ever touched — even while a restore already holds it', async () => {
      const lock = await acquireRestoreLock()
      expect(lock.ok).toBe(true)
      if (!lock.ok) throw new Error(EXPECTED_OK_MESSAGE)
      try {
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/admin/backups/${encodeURIComponent('../../etc/passwd')}/restore`,
          headers: { cookie: cookieHeader(operatorCookies) },
          payload: { confirmRestore: true, reason: 'test' },
        })
        // If the lock had been touched first, this would have come back 409 (restore_in_progress)
        // instead — 400 invalid_filename proves the filename check ran first, with zero lock/DB
        // involvement, exactly as D1.9 requires.
        expect(res.statusCode).toBe(400)
        expect(res.json()).toMatchObject({ code: 'invalid_filename' })
      } finally {
        await lock.release()
      }
    })

    it('AC-2: a second concurrent restore request is rejected 409 restore_in_progress without ever touching storage', async () => {
      const lock = await acquireRestoreLock()
      expect(lock.ok).toBe(true)
      if (!lock.ok) throw new Error(EXPECTED_OK_MESSAGE)
      try {
        // A nonexistent-but-well-formed filename: if the lock had NOT stopped this request before
        // storage.read, the outcome would be 404 backup_not_found instead of 409 — proving the
        // rejection happened at the lock, before any storage I/O.
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/admin/backups/${wellFormedNonexistentFilename()}/restore`,
          headers: { cookie: cookieHeader(operatorCookies) },
          payload: { confirmRestore: true, reason: 'test' },
        })
        expect(res.statusCode).toBe(409)
        expect(res.json()).toMatchObject({ code: 'restore_in_progress' })
      } finally {
        await lock.release()
      }
    })

    it('AC-3: restore is rejected 409 backup_in_progress while a backup dump is already running', async () => {
      const filename = await seedSucceededBackup()
      // triggeredBy: 'manual' (not 'schedule') — see restore-lock.test.ts's insertRunningBackupRow
      // comment: backup-snapshot.test.ts's scheduled-fire test filters backup_runs by
      // triggeredBy='schedule' with no orderBy/limit, so a stray 'schedule'-triggered row left in
      // this shared test database (even cleaned up to 'failed') could pollute that query.
      const [runningRow] = await getDb()
        .insert(backupRuns)
        .values({
          filename: `backup_inflight-${randomUUID()}.vault`,
          status: 'running',
          triggeredBy: 'manual',
        })
        .returning({ id: backupRuns.id })
      if (!runningRow) throw new Error('expected inserted row')
      try {
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/admin/backups/${filename}/restore`,
          headers: { cookie: cookieHeader(operatorCookies) },
          payload: { confirmRestore: true, reason: 'test' },
        })
        expect(res.statusCode).toBe(409)
        expect(res.json()).toMatchObject({ code: 'backup_in_progress' })
      } finally {
        await getDb()
          .update(backupRuns)
          .set({ status: 'failed' })
          .where(eq(backupRuns.id, runningRow.id))
      }
    })

    it('AC-4: POST /backup/trigger returns 409 backup_already_running while a restore holds the lock (zero changes to acquireBackupSlot)', async () => {
      const lock = await acquireRestoreLock()
      expect(lock.ok).toBe(true)
      if (!lock.ok) throw new Error(EXPECTED_OK_MESSAGE)
      try {
        const res = await app.inject({
          method: 'POST',
          url: TRIGGER_URL,
          headers: { cookie: cookieHeader(operatorCookies) },
        })
        expect(res.statusCode).toBe(409)
        expect(res.json()).toMatchObject({ code: 'backup_already_running' })
      } finally {
        await lock.release()
      }
    })

    it('AC-5: validate succeeds (200) even while a restore holds the lock — validate is never gated by it', async () => {
      const filename = await seedSucceededBackup()
      const lock = await acquireRestoreLock()
      expect(lock.ok).toBe(true)
      if (!lock.ok) throw new Error(EXPECTED_OK_MESSAGE)
      try {
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/admin/backups/${filename}/validate`,
          headers: { cookie: cookieHeader(operatorCookies) },
        })
        expect(res.statusCode).toBe(200)
      } finally {
        await lock.release()
      }
    })

    it('AC-6: the lock is released after each of the three HTTP-reachable non-destructive restore outcomes (not_found, checksum_mismatch, decrypt_failed)', async () => {
      const cookie = cookieHeader(operatorCookies)

      // not_found
      await app.inject({
        method: 'POST',
        url: `/api/v1/admin/backups/${wellFormedNonexistentFilename()}/restore`,
        headers: { cookie },
        payload: { confirmRestore: true, reason: 'test' },
      })
      expect(await probeLockFree()).toBe(true)

      // checksum_mismatch
      const tamperedFilename = await seedSucceededBackup()
      const storage = backupStorageFor({ type: 'filesystem', path: storageDir })
      const tampered = await storage.read(tamperedFilename)
      tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff
      await storage.write(tamperedFilename, tampered)
      await app.inject({
        method: 'POST',
        url: `/api/v1/admin/backups/${tamperedFilename}/restore`,
        headers: { cookie },
        payload: { confirmRestore: true, reason: 'test' },
      })
      expect(await probeLockFree()).toBe(true)

      // decrypt_failed
      const { runBackupCrypto } = await import('@project-vault/crypto')
      const { createHash, randomBytes } = await import('node:crypto')
      const wrongKeyFilename = `backup_20260101T000000000Z_${randomUUID()}.vault`
      const wrongKeyMetaFilename = wrongKeyFilename.replace(/\.vault$/, '.meta.json')
      const wrongKey = randomBytes(32)
      const encryptedUnderWrongKey = await runBackupCrypto(
        'encrypt',
        Buffer.from('irrelevant'),
        wrongKey
      )
      const wrongKeyChecksum = createHash('sha256').update(encryptedUnderWrongKey).digest('hex')
      await storage.write(wrongKeyFilename, encryptedUnderWrongKey)
      await storage.write(
        wrongKeyMetaFilename,
        Buffer.from(JSON.stringify({ checksumSha256: wrongKeyChecksum }))
      )
      await app.inject({
        method: 'POST',
        url: `/api/v1/admin/backups/${wrongKeyFilename}/restore`,
        headers: { cookie },
        payload: { confirmRestore: true, reason: 'test' },
      })
      expect(await probeLockFree()).toBe(true)
    })
  })

  // Story 9.6 AC-20: every restore attempt (accepted or rejected) is audit-logged with the
  // actor's identity — a dedicated app instance with a log-capture stream, since the shared `app`
  // above runs with `logger: false`.
  describe('Story 9.6 AC-20: restore attempts are audit-logged', () => {
    it('logs backup.restore_attempted for a filename-rejected, lock-rejected, and accepted request', async () => {
      const { stream, lines } = createLogCaptureStream()
      const logApp = await createApp({
        logger: {
          ...createLoggerConfig({
            NODE_ENV: 'development',
            LOG_LEVEL: 'info',
            SERVICE_NAME: 'api',
          }),
          stream,
        },
        vaultGuardEnabled: true,
      })
      const cookie = cookieHeader(operatorCookies)

      try {
        // 1. filename-rejected
        await logApp.inject({
          method: 'POST',
          url: `/api/v1/admin/backups/${encodeURIComponent('../../etc/passwd')}/restore`,
          headers: { cookie },
          payload: { confirmRestore: true, reason: 'test' },
        })

        // 2. lock-rejected
        const lock = await acquireRestoreLock()
        expect(lock.ok).toBe(true)
        if (!lock.ok) throw new Error(EXPECTED_OK_MESSAGE)
        const lockRejectedFilename = wellFormedNonexistentFilename()
        await logApp.inject({
          method: 'POST',
          url: `/api/v1/admin/backups/${lockRejectedFilename}/restore`,
          headers: { cookie },
          payload: { confirmRestore: true, reason: 'test' },
        })
        await lock.release()

        // 3. accepted (resolves to not_found, a safe, non-destructive outcome)
        const acceptedFilename = wellFormedNonexistentFilename()
        await logApp.inject({
          method: 'POST',
          url: `/api/v1/admin/backups/${acceptedFilename}/restore`,
          headers: { cookie },
          payload: { confirmRestore: true, reason: 'test' },
        })

        await flushCapturedLogger(logApp.log)
        const attemptLogs = parseCapturedLogLines(lines).filter(
          (line) => line['eventType'] === OperationalEvent.BACKUP_RESTORE_ATTEMPTED
        )

        expect(
          attemptLogs.some((l) => l['outcome'] === 'rejected' && l['reason'] === 'invalid_filename')
        ).toBe(true)
        expect(
          attemptLogs.some(
            (l) =>
              l['outcome'] === 'rejected' &&
              l['reason'] === 'restore_in_progress' &&
              l['filename'] === lockRejectedFilename
          )
        ).toBe(true)
        expect(
          attemptLogs.some(
            (l) => l['outcome'] === 'not_found' && l['filename'] === acceptedFilename
          )
        ).toBe(true)
        for (const l of attemptLogs) {
          expect(l['actorId']).toBeTruthy()
        }
      } finally {
        await logApp.close()
      }
    })
  })
})
