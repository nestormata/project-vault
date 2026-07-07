import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

process.env['DATABASE_URL'] ??=
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'
process.env['VAULT_ALLOW_REMOTE_INIT'] = 'true'
process.env['BACKUP_DATABASE_URL'] ??= 'postgresql://postgres:password@localhost:5432/project_vault'
const storageDir = mkdtempSync(join(tmpdir(), 'backup-health-check-test-'))
process.env['BACKUP_STORAGE_PATH'] = storageDir
process.env['BACKUP_MAX_AGE_HOURS'] = '25'

const { initVault } = await import('../modules/vault/key-service.js')
const { resetVaultForTest } = await import('../__tests__/helpers/vault-test-cleanup.js')
const { getDb } = await import('@project-vault/db')
const { backupRuns, adminAlerts } = await import('@project-vault/db/schema')
const { eq, and } = await import('drizzle-orm')
const { runBackupHealthCheck } = await import('./backup-health-check.js')
const { acquireBackupSlot, executeBackupSnapshot } = await import('../modules/backup/service.js')
const { backupStorageFor } = await import('../modules/backup/storage.js')

const FAKE_DUMP_SQL = Buffer.from('CREATE TABLE "users" (id uuid);')
const BACKUP_MISSED_ALERT_TYPE = 'backup.missed'

function fakeBoss() {
  return { send: vi.fn(async () => 'job-id'), isStarted: () => false } as unknown as Parameters<
    typeof runBackupHealthCheck
  >[0]
}

async function clearAllBackupMissedAlerts(): Promise<void> {
  await getDb().delete(adminAlerts).where(eq(adminAlerts.alertType, BACKUP_MISSED_ALERT_TYPE))
}

describe.sequential('Story 9.1 AC-12: backup-health-check worker', () => {
  beforeAll(async () => {
    await resetVaultForTest()
    try {
      await initVault(
        { kmsType: 'passphrase', passphrase: 'backup-health-check-test-passphrase' },
        {}
      )
    } catch (error) {
      if ((error as { code?: string }).code !== 'ALREADY_INITIALIZED') throw error
    }
  })

  afterAll(async () => {
    await resetVaultForTest()
    rmSync(storageDir, { recursive: true, force: true })
  })

  it('does nothing when the last succeeded backup is recent (healthy, no alert)', async () => {
    await clearAllBackupMissedAlerts()
    const storage = backupStorageFor({ type: 'filesystem', path: storageDir })
    const slot = await acquireBackupSlot({ triggeredBy: 'manual' })
    if (!slot.ok) throw new Error('expected slot')
    await executeBackupSnapshot(
      { runId: slot.runId, filename: slot.filename, metaFilename: slot.metaFilename },
      { dump: async () => FAKE_DUMP_SQL, storage }
    )

    await runBackupHealthCheck(fakeBoss())

    const alerts = await getDb()
      .select()
      .from(adminAlerts)
      .where(eq(adminAlerts.alertType, BACKUP_MISSED_ALERT_TYPE))
    expect(alerts.length).toBe(0)
  })

  it('creates a backup.missed alert when the last succeeded backup exceeds BACKUP_MAX_AGE_HOURS', async () => {
    await clearAllBackupMissedAlerts()
    const storage = backupStorageFor({ type: 'filesystem', path: storageDir })
    const slot = await acquireBackupSlot({ triggeredBy: 'manual' })
    if (!slot.ok) throw new Error('expected slot')
    await executeBackupSnapshot(
      { runId: slot.runId, filename: slot.filename, metaFilename: slot.metaFilename },
      { dump: async () => FAKE_DUMP_SQL, storage }
    )
    // Backdate completedAt beyond the max-age threshold.
    const staleCompletedAt = new Date(Date.now() - 26 * 60 * 60 * 1000)
    await getDb()
      .update(backupRuns)
      .set({ completedAt: staleCompletedAt })
      .where(eq(backupRuns.id, slot.runId))

    await runBackupHealthCheck(fakeBoss())

    const alerts = await getDb()
      .select()
      .from(adminAlerts)
      .where(
        and(eq(adminAlerts.alertType, BACKUP_MISSED_ALERT_TYPE), eq(adminAlerts.status, 'active'))
      )
    expect(alerts.length).toBe(1)
  })

  it('does not re-create the alert while the condition persists (idempotent)', async () => {
    await runBackupHealthCheck(fakeBoss())
    await runBackupHealthCheck(fakeBoss())

    const alerts = await getDb()
      .select()
      .from(adminAlerts)
      .where(
        and(eq(adminAlerts.alertType, BACKUP_MISSED_ALERT_TYPE), eq(adminAlerts.status, 'active'))
      )
    expect(alerts.length).toBe(1)
  })
})
