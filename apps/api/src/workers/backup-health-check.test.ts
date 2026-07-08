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
const { eq, and, desc } = await import('drizzle-orm')
const { OperationalEvent } = await import('@project-vault/shared')
const { runBackupHealthCheck } = await import('./backup-health-check.js')
const { acquireBackupSlot, executeBackupSnapshot } = await import('../modules/backup/service.js')
const { backupStorageFor } = await import('../modules/backup/storage.js')

const FAKE_DUMP_SQL = Buffer.from('CREATE TABLE "users" (id uuid);')
const BACKUP_MISSED_ALERT_TYPE = 'backup.missed'
const STALE_HOURS_MS = 26 * 60 * 60 * 1000
const EXPECTED_SLOT_MESSAGE = 'expected slot'

function fakeBoss() {
  return { send: vi.fn(async () => 'job-id'), isStarted: () => false } as unknown as Parameters<
    typeof runBackupHealthCheck
  >[0]
}

function silentLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

async function clearAllBackupMissedAlerts(): Promise<void> {
  await getDb().delete(adminAlerts).where(eq(adminAlerts.alertType, BACKUP_MISSED_ALERT_TYPE))
}

async function seedHealthyBackup(): Promise<void> {
  const storage = backupStorageFor({ type: 'filesystem', path: storageDir })
  const slot = await acquireBackupSlot({ triggeredBy: 'manual' })
  if (!slot.ok) throw new Error(EXPECTED_SLOT_MESSAGE)
  await executeBackupSnapshot(
    { runId: slot.runId, filename: slot.filename, metaFilename: slot.metaFilename },
    { dump: async () => FAKE_DUMP_SQL, storage }
  )
}

async function staleMostRecentSucceededBackup(): Promise<void> {
  const [latest] = await getDb()
    .select({ id: backupRuns.id })
    .from(backupRuns)
    .where(eq(backupRuns.status, 'succeeded'))
    .orderBy(desc(backupRuns.startedAt))
    .limit(1)
  if (!latest) throw new Error('expected a succeeded backup_runs row')
  await getDb()
    .update(backupRuns)
    .set({ completedAt: new Date(Date.now() - STALE_HOURS_MS) })
    .where(eq(backupRuns.id, latest.id))
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
    if (!slot.ok) throw new Error(EXPECTED_SLOT_MESSAGE)
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
    if (!slot.ok) throw new Error(EXPECTED_SLOT_MESSAGE)
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

  // Story 9.6 D2/AC-8 through AC-11: backup.missed auto-resolve.
  describe('Story 9.6 D2: backup.missed auto-resolve', () => {
    it('AC-8: the active alert transitions to acknowledged once a healthy backup exists again', async () => {
      // Precondition: the previous test left exactly one active backup.missed alert.
      const before = await getDb()
        .select()
        .from(adminAlerts)
        .where(
          and(eq(adminAlerts.alertType, BACKUP_MISSED_ALERT_TYPE), eq(adminAlerts.status, 'active'))
        )
      expect(before.length).toBe(1)
      const alertId = before[0]?.id
      if (!alertId) throw new Error('expected an active alert')

      await seedHealthyBackup()
      await runBackupHealthCheck(fakeBoss())

      const [resolved] = await getDb().select().from(adminAlerts).where(eq(adminAlerts.id, alertId))
      expect(resolved?.status).toBe('acknowledged')
      expect(resolved?.acknowledgedAt).not.toBeNull()

      const stillActive = await getDb()
        .select()
        .from(adminAlerts)
        .where(
          and(eq(adminAlerts.alertType, BACKUP_MISSED_ALERT_TYPE), eq(adminAlerts.status, 'active'))
        )
      expect(stillActive.length).toBe(0)
    })

    it('AC-9: a fresh, distinct alert is created for a later re-miss — the resolved episode does not permanently suppress it', async () => {
      // Currently healthy (from AC-8) — go stale again.
      await staleMostRecentSucceededBackup()
      await runBackupHealthCheck(fakeBoss())

      const activeAlerts = await getDb()
        .select()
        .from(adminAlerts)
        .where(
          and(eq(adminAlerts.alertType, BACKUP_MISSED_ALERT_TYPE), eq(adminAlerts.status, 'active'))
        )
      expect(activeAlerts.length).toBe(1)

      const acknowledgedAlerts = await getDb()
        .select()
        .from(adminAlerts)
        .where(
          and(
            eq(adminAlerts.alertType, BACKUP_MISSED_ALERT_TYPE),
            eq(adminAlerts.status, 'acknowledged')
          )
        )
      expect(acknowledgedAlerts.length).toBeGreaterThanOrEqual(1)
      // Distinct row — the new active alert is not the same id as any acknowledged one.
      expect(acknowledgedAlerts.some((a) => a.id === activeAlerts[0]?.id)).toBe(false)
    })

    it('AC-9 edge: running the healthy branch twice with no active alert is an idempotent no-op', async () => {
      await clearAllBackupMissedAlerts()
      await seedHealthyBackup()

      await expect(runBackupHealthCheck(fakeBoss())).resolves.toBeUndefined()
      await expect(runBackupHealthCheck(fakeBoss())).resolves.toBeUndefined()

      const alerts = await getDb()
        .select()
        .from(adminAlerts)
        .where(eq(adminAlerts.alertType, BACKUP_MISSED_ALERT_TYPE))
      expect(alerts.length).toBe(0)
    })

    it('AC-10: resolving backup.missed leaves other admin_alerts types (key_custody_risk, backup.failure) completely untouched', async () => {
      await clearAllBackupMissedAlerts()

      const [missedAlert] = await getDb()
        .insert(adminAlerts)
        .values({ alertType: BACKUP_MISSED_ALERT_TYPE, severity: 'critical', payload: {} })
        .returning({ id: adminAlerts.id })
      const [custodyAlert] = await getDb()
        .insert(adminAlerts)
        .values({ alertType: 'key_custody_risk', severity: 'warning', payload: {} })
        .returning({ id: adminAlerts.id })
      const [failureAlert] = await getDb()
        .insert(adminAlerts)
        .values({ alertType: 'backup.failure', severity: 'critical', payload: {} })
        .returning({ id: adminAlerts.id })
      if (!missedAlert || !custodyAlert || !failureAlert) throw new Error('expected inserted rows')

      await seedHealthyBackup()
      await runBackupHealthCheck(fakeBoss())

      const [resolvedMissed] = await getDb()
        .select()
        .from(adminAlerts)
        .where(eq(adminAlerts.id, missedAlert.id))
      expect(resolvedMissed?.status).toBe('acknowledged')

      const [untouchedCustody] = await getDb()
        .select()
        .from(adminAlerts)
        .where(eq(adminAlerts.id, custodyAlert.id))
      expect(untouchedCustody?.status).toBe('active')
      expect(untouchedCustody?.acknowledgedAt).toBeNull()

      const [untouchedFailure] = await getDb()
        .select()
        .from(adminAlerts)
        .where(eq(adminAlerts.id, failureAlert.id))
      expect(untouchedFailure?.status).toBe('active')
      expect(untouchedFailure?.acknowledgedAt).toBeNull()
    })

    it('AC-11: resolution is logged operationally (backup.missed_resolved) and delivers no notification', async () => {
      await clearAllBackupMissedAlerts()
      await getDb()
        .insert(adminAlerts)
        .values({ alertType: BACKUP_MISSED_ALERT_TYPE, severity: 'critical', payload: {} })
      await seedHealthyBackup()

      const logger = silentLogger()
      const boss = fakeBoss()
      await runBackupHealthCheck(boss, logger)

      const resolvedLogCall = logger.info.mock.calls.find(
        (call) =>
          (call[0] as { eventType?: string })?.eventType === OperationalEvent.BACKUP_MISSED_RESOLVED
      )
      expect(resolvedLogCall).toBeDefined()
      expect(boss.send).not.toHaveBeenCalled()
    })

    it('D2 failure isolation (adversarial review, high): a thrown error while resolving is caught, logged, and does not crash the health check', async () => {
      await clearAllBackupMissedAlerts()
      await getDb()
        .insert(adminAlerts)
        .values({ alertType: BACKUP_MISSED_ALERT_TYPE, severity: 'critical', payload: {} })
      await seedHealthyBackup()

      const logger = silentLogger()
      const boom = new Error('simulated DB failure while clearing the backup.missed episode')

      await expect(
        runBackupHealthCheck(fakeBoss(), logger, {
          clearBackupMissedAlert: async () => {
            throw boom
          },
        })
      ).resolves.toBeUndefined()

      const failureLogCall = logger.error.mock.calls.find(
        (call) =>
          (call[0] as { eventType?: string })?.eventType ===
          OperationalEvent.BACKUP_MISSED_RESOLVE_FAILED
      )
      expect(failureLogCall).toBeDefined()
    })
  })
})
