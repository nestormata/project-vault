/* eslint-disable security/detect-non-literal-fs-filename -- test exercises dynamic temp-dir paths */
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

process.env['DATABASE_URL'] ??=
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'
process.env['VAULT_ALLOW_REMOTE_INIT'] = 'true'
process.env['BACKUP_DATABASE_URL'] ??= 'postgresql://postgres:password@localhost:5432/project_vault'
process.env['BACKUP_MAX_AGE_HOURS'] = '25'
process.env['BACKUP_S3_BUCKET'] = 'vault-backups-staging-test'
delete process.env['BACKUP_STORAGE_PATH']
const stagingDir = mkdtempSync(join(tmpdir(), 'backup-health-check-staging-test-'))
process.env['BACKUP_S3_STAGING_PATH'] = stagingDir

const { initVault } = await import('../modules/vault/key-service.js')
const { resetVaultForTest } = await import('../__tests__/helpers/vault-test-cleanup.js')
const { getDb } = await import('@project-vault/db')
const { adminAlerts, backupRuns } = await import('@project-vault/db/schema')
const { eq, and } = await import('drizzle-orm')
const { runBackupHealthCheck } = await import('./backup-health-check.js')

const DISK_PRESSURE_ALERT_TYPE = 'backup.staging_disk_pressure'
const OLD_MTIME_SECONDS = (Date.now() - 30 * 60 * 60 * 1000) / 1000
const RECENT_BACKUP_HOURS_AGO_MS = 3 * 60 * 60 * 1000

function fakeBoss() {
  return { send: vi.fn(async () => 'job-id'), isStarted: () => false } as unknown as Parameters<
    typeof runBackupHealthCheck
  >[0]
}

function silentLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

async function clearDiskPressureAlerts(): Promise<void> {
  await getDb().delete(adminAlerts).where(eq(adminAlerts.alertType, DISK_PRESSURE_ALERT_TYPE))
}

/** A healthy backup_runs row so runBackupHealthCheck's own missed/resolve branch is a no-op and
 * doesn't interfere with these staging-maintenance-focused assertions. */
async function seedRecentSucceededRun(): Promise<void> {
  await getDb()
    .insert(backupRuns)
    .values({
      filename: `backup_${Date.now()}_staging-test.vault`,
      status: 'succeeded',
      triggeredBy: 'manual',
      completedAt: new Date(Date.now() - RECENT_BACKUP_HOURS_AGO_MS),
    })
}

describe.sequential('Story 9.6 D3.4: backup-health-check S3 staging maintenance', () => {
  beforeAll(async () => {
    await resetVaultForTest()
    try {
      await initVault(
        { kmsType: 'passphrase', passphrase: 'backup-health-check-staging-test-passphrase' },
        {}
      )
    } catch (error) {
      if ((error as { code?: string }).code !== 'ALREADY_INITIALIZED') throw error
    }
    await seedRecentSucceededRun()
  })

  afterAll(async () => {
    await resetVaultForTest()
    rmSync(stagingDir, { recursive: true, force: true })
  })

  it('AC-16: deletes .staged files older than 24h, keeps younger ones, ignores non-.staged files', async () => {
    const oldStaged = join(stagingDir, 'backup_old.vault.staged')
    const newStaged = join(stagingDir, 'backup_new.vault.staged')
    const unrelated = join(stagingDir, 'notes.txt')
    writeFileSync(oldStaged, 'old')
    writeFileSync(newStaged, 'new')
    writeFileSync(unrelated, 'unrelated')
    utimesSync(oldStaged, OLD_MTIME_SECONDS, OLD_MTIME_SECONDS)
    utimesSync(unrelated, OLD_MTIME_SECONDS, OLD_MTIME_SECONDS)

    await runBackupHealthCheck(fakeBoss())

    const remaining = readdirSync(stagingDir).sort()
    expect(remaining).toEqual(['backup_new.vault.staged', 'notes.txt'].sort())
  })

  it('AC-16b: raises backup.staging_disk_pressure once cumulative usage exceeds BACKUP_S3_STAGING_MAX_BYTES, clears once back under', async () => {
    await clearDiskPressureAlerts()
    // A deps override (rather than a live BACKUP_S3_STAGING_MAX_BYTES env mutation) is used here
    // since env.ts parses process.env once at first import — this test file's earlier top-level
    // `await import('./backup-health-check.js')` already triggered that parse.
    writeFileSync(join(stagingDir, 'big.vault.staged'), Buffer.alloc(500))

    const boss = fakeBoss()
    await runBackupHealthCheck(boss, silentLogger(), {
      stagingMaxBytes: 100,
    })

    const activeAlerts = await getDb()
      .select()
      .from(adminAlerts)
      .where(
        and(eq(adminAlerts.alertType, DISK_PRESSURE_ALERT_TYPE), eq(adminAlerts.status, 'active'))
      )
    expect(activeAlerts.length).toBe(1)
    const payload = activeAlerts[0]?.payload as { totalBytes: number; fileCount: number }
    expect(payload.totalBytes).toBeGreaterThan(100)
    expect(payload.fileCount).toBeGreaterThanOrEqual(1)

    // Remove the oversized file — usage now back under threshold — alert should clear.
    rmSync(join(stagingDir, 'big.vault.staged'), { force: true })
    await runBackupHealthCheck(fakeBoss(), silentLogger(), { stagingMaxBytes: 100 })

    const stillActive = await getDb()
      .select()
      .from(adminAlerts)
      .where(
        and(eq(adminAlerts.alertType, DISK_PRESSURE_ALERT_TYPE), eq(adminAlerts.status, 'active'))
      )
    expect(stillActive.length).toBe(0)
  })

  it('D3.10/failure isolation: a cleanup-scan failure does not prevent the disk-pressure check from running, and vice versa', async () => {
    await clearDiskPressureAlerts()
    writeFileSync(join(stagingDir, 'pressure.vault.staged'), Buffer.alloc(500))
    const logger = silentLogger()
    const boom = new Error('simulated cleanup scan failure')

    await expect(
      runBackupHealthCheck(fakeBoss(), logger, {
        cleanupOrphanedStagedFiles: async () => {
          throw boom
        },
        stagingMaxBytes: 100,
      })
    ).resolves.toBeUndefined()

    expect(logger.error).toHaveBeenCalled()
    // The disk-pressure check still ran despite the cleanup-scan throwing — independent try/catch.
    const activeAlerts = await getDb()
      .select()
      .from(adminAlerts)
      .where(
        and(eq(adminAlerts.alertType, DISK_PRESSURE_ALERT_TYPE), eq(adminAlerts.status, 'active'))
      )
    expect(activeAlerts.length).toBe(1)

    rmSync(join(stagingDir, 'pressure.vault.staged'), { force: true })
    await clearDiskPressureAlerts()
  })

  it('AC-16 edge: no-op (does not throw) when running against a filesystem destination instead of S3', async () => {
    // Sanity check that the overall health check remains well-behaved; the true "filesystem
    // destination -> no staging scan at all" no-op behavior is covered by the main
    // backup-health-check.test.ts suite (which configures BACKUP_STORAGE_PATH, not
    // BACKUP_S3_BUCKET) continuing to pass unmodified — see AC-17's regression-guard language.
    await expect(runBackupHealthCheck(fakeBoss())).resolves.toBeUndefined()
  })
})
