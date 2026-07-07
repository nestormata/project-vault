import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

process.env['DATABASE_URL'] ??=
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'
process.env['VAULT_ALLOW_REMOTE_INIT'] = 'true'
const storageDir = mkdtempSync(join(tmpdir(), 'key-custody-check-test-'))
process.env['BACKUP_STORAGE_PATH'] = storageDir
process.env['BACKUP_DATABASE_URL'] ??= 'postgresql://postgres:password@localhost:5432/project_vault'
process.env['KEY_ROTATION_MAX_AGE_DAYS'] = '365'

const { initVault } = await import('../modules/vault/key-service.js')
const { resetVaultForTest } = await import('../__tests__/helpers/vault-test-cleanup.js')
const { getDb } = await import('@project-vault/db')
const { adminAlerts, vaultState } = await import('@project-vault/db/schema')
const { eq, sql } = await import('drizzle-orm')
const { evaluateKeyCustodyTriggers, runKeyCustodyCheck } = await import('./key-custody-check.js')

const KEY_CUSTODY_ALERT_TYPE = 'key_custody_risk'

function fakeBoss() {
  return { send: vi.fn(async () => 'job-id'), isStarted: () => true } as unknown as Parameters<
    typeof runKeyCustodyCheck
  >[0]
}

async function clearKeyCustodyAlerts(): Promise<void> {
  await getDb().delete(adminAlerts).where(eq(adminAlerts.alertType, KEY_CUSTODY_ALERT_TYPE))
}

/** vault_state is append-only (trigger-enforced, 0003_vault_state.sql) — the only bypass is the
 * test-only `app.vault_test_reset` GUC (SET LOCAL, scoped to this transaction), same discipline
 * resetVaultForTest() uses. Needed here to simulate different kmsType/keyRotatedAt states. */
async function setVaultStateForTest(values: {
  kmsType?: 'passphrase' | 'envelope' | 'file' | 'kms'
  keyRotatedAt?: Date
}): Promise<void> {
  await getDb().transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.vault_test_reset', 'true', true)`)
    await tx.update(vaultState).set(values).where(eq(vaultState.id, 1))
  })
}

describe.sequential('Story 9.2 FR109/AC-19/AC-20: key-custody-check worker', () => {
  beforeAll(async () => {
    await resetVaultForTest()
    try {
      await initVault({ kmsType: 'passphrase', passphrase: 'key-custody-check-test' }, {})
    } catch (error) {
      if ((error as { code?: string }).code !== 'ALREADY_INITIALIZED') throw error
    }
    await setVaultStateForTest({ kmsType: 'file' })
  })

  afterAll(async () => {
    // Defense in depth: this file's last test already leaves zero active key_custody_risk rows,
    // but clear explicitly regardless of test order/future additions — a leftover active row
    // would otherwise leak into other test files sharing this database (see the analogous
    // audit-storage-check.test.ts fix for the maintenance-mode-suppression class of this bug).
    await clearKeyCustodyAlerts()
    await resetVaultForTest()
    rmSync(storageDir, { recursive: true, force: true })
  })

  it('AC-19: trigger (a) — file KMS + backup enabled', async () => {
    await setVaultStateForTest({ keyRotatedAt: new Date() })
    const triggers = await evaluateKeyCustodyTriggers()
    expect(triggers).toContain('file_kms_with_backup')
    expect(triggers).not.toContain('key_age_exceeded')
  })

  it('AC-20: trigger (b) — key age exceeds KEY_ROTATION_MAX_AGE_DAYS', async () => {
    await setVaultStateForTest({
      kmsType: 'kms',
      keyRotatedAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000),
    })
    const triggers = await evaluateKeyCustodyTriggers()
    expect(triggers).toContain('key_age_exceeded')
    expect(triggers).not.toContain('file_kms_with_backup')
    await setVaultStateForTest({ kmsType: 'file' })
  })

  it('AC-20 edge: both triggers active simultaneously merge into one payload', async () => {
    await clearKeyCustodyAlerts()
    await setVaultStateForTest({
      kmsType: 'file',
      keyRotatedAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000),
    })
    const boss = fakeBoss()
    await runKeyCustodyCheck(boss, undefined)

    const [row] = await getDb()
      .select()
      .from(adminAlerts)
      .where(eq(adminAlerts.alertType, KEY_CUSTODY_ALERT_TYPE))
    expect(row?.status).toBe('active')
    const payload = row?.payload as { triggers: string[] }
    expect(payload.triggers).toEqual(
      expect.arrayContaining(['file_kms_with_backup', 'key_age_exceeded'])
    )
  })

  it('AC-19 idempotency: a second check does not create a duplicate active row', async () => {
    const boss = fakeBoss()
    await runKeyCustodyCheck(boss, undefined)
    const rows = await getDb()
      .select()
      .from(adminAlerts)
      .where(eq(adminAlerts.alertType, KEY_CUSTODY_ALERT_TYPE))
    expect(rows.filter((r) => r.status === 'active')).toHaveLength(1)
  })

  it('negative: neither trigger active produces no alert', async () => {
    await clearKeyCustodyAlerts()
    await setVaultStateForTest({ kmsType: 'kms', keyRotatedAt: new Date() })
    const boss = fakeBoss()
    await runKeyCustodyCheck(boss, undefined)
    const rows = await getDb()
      .select()
      .from(adminAlerts)
      .where(eq(adminAlerts.alertType, KEY_CUSTODY_ALERT_TYPE))
    expect(rows.filter((r) => r.status === 'active')).toHaveLength(0)
  })
})
