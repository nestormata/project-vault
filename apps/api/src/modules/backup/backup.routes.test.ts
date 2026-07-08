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
const storageDir = mkdtempSync(join(tmpdir(), 'backup-routes-test-'))
process.env['BACKUP_STORAGE_PATH'] = storageDir

const { createApp } = await import('../../app.js')
const { initVault } = await import('../vault/key-service.js')
const { resetVaultForTest } = await import('../../__tests__/helpers/vault-test-cleanup.js')
const { registerAndLoginViaApi, cookieHeader, assertRoutesFailClosedWhileSealed } =
  await import('../../__tests__/helpers/auth-test-helpers.js')
const { getDb } = await import('@project-vault/db')
const { backupRuns, users } = await import('@project-vault/db/schema')
const { acquireBackupSlot, executeBackupSnapshot } = await import('./service.js')
const { backupStorageFor } = await import('./storage.js')

const TEST_PASSPHRASE = 'backup-routes-test-passphrase'
const TRIGGER_URL = '/api/v1/admin/backup/trigger'
const BACKUPS_URL = '/api/v1/admin/backups'
const FAKE_DUMP_SQL = Buffer.from(`
CREATE TABLE "organizations" (id uuid);
CREATE TABLE "users" (id uuid);
CREATE TABLE "projects" (id uuid);
CREATE TABLE "credentials" (id uuid);
CREATE TABLE "audit_log_entries" (id uuid);
`)

type TestApp = Awaited<ReturnType<typeof createApp>>

let app: TestApp
let operatorCookies: Record<string, string>

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
    await app.close()
    await resetVaultForTest()
    rmSync(storageDir, { recursive: true, force: true })
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
      url: `/api/v1/admin/backups/nonexistent-${randomUUID()}.vault/restore`,
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
    expect(after.length).toBe(before.length)
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
      const filename = `nonexistent-${randomUUID()}.vault`

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
})
