import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'

// Story 9.1 AC-15: a dedicated test file (fresh module registry, per-file isolation) with
// BACKUP_STORAGE_PATH/BACKUP_S3_BUCKET/BACKUP_DATABASE_URL all left unset from the very first
// import of config/env.ts — env.ts is a module-level singleton computed once per process/file,
// so this scenario cannot be exercised by toggling process.env mid-file the way
// backup.routes.test.ts's other (backup-enabled) scenarios do.
process.env['DATABASE_URL'] ??=
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'
process.env['VAULT_ALLOW_REMOTE_INIT'] = 'true'
delete process.env['BACKUP_STORAGE_PATH']
delete process.env['BACKUP_S3_BUCKET']
delete process.env['BACKUP_DATABASE_URL']

const { createApp } = await import('../../app.js')
const { initVault } = await import('../vault/key-service.js')
const { resetVaultForTest } = await import('../../__tests__/helpers/vault-test-cleanup.js')
const { registerAndLoginViaApi, cookieHeader } =
  await import('../../__tests__/helpers/auth-test-helpers.js')
const { getDb } = await import('@project-vault/db')
const { users } = await import('@project-vault/db/schema')

type TestApp = Awaited<ReturnType<typeof createApp>>
let app: TestApp

describe.sequential('Story 9.1 AC-15: backup disabled entirely (no BACKUP_* configured)', () => {
  beforeAll(async () => {
    await resetVaultForTest()
    await initVault({ kmsType: 'passphrase', passphrase: 'backup-disabled-test-passphrase' }, {})
    app = await createApp({ logger: false, vaultGuardEnabled: true })
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  it('starts up successfully with no backup env vars configured', () => {
    expect(app).toBeDefined()
  })

  it('POST /backup/trigger returns 503 backup_not_configured rather than a silent no-op', async () => {
    const { cookies, userId } = await registerAndLoginViaApi(app, {
      email: `disabled-operator-${randomUUID()}@example.com`,
      password: 'correct-horse-battery-staple9',
      orgName: `Disabled Org ${randomUUID()}`,
    })
    // See backup.routes.test.ts's beforeAll for why this direct promotion is necessary in a
    // shared test database (mirrors AC-3's documented manual-promotion upgrade path).
    await getDb().transaction(async (tx) => {
      await tx
        .update(users)
        .set({ isPlatformOperator: false })
        .where(eq(users.isPlatformOperator, true))
      await tx.update(users).set({ isPlatformOperator: true }).where(eq(users.id, userId))
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/backup/trigger',
      headers: { cookie: cookieHeader(cookies) },
    })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toMatchObject({ code: 'backup_not_configured' })
  })
})
