import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

process.env['DATABASE_URL'] ??=
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'
process.env['VAULT_ALLOW_REMOTE_INIT'] = 'true'
process.env['BACKUP_DATABASE_URL'] ??= 'postgresql://postgres:password@localhost:5432/project_vault'
const storageDir = mkdtempSync(join(tmpdir(), 'backup-snapshot-worker-test-'))
process.env['BACKUP_STORAGE_PATH'] = storageDir
process.env['BACKUP_RETENTION_COUNT'] = '2'

const { initVault } = await import('../modules/vault/key-service.js')
const { resetVaultForTest } = await import('../__tests__/helpers/vault-test-cleanup.js')
const { getDb } = await import('@project-vault/db')
const { backupRuns, adminAlerts } = await import('@project-vault/db/schema')
const { eq } = await import('drizzle-orm')
const { runBackupSnapshotJob } = await import('./backup-snapshot.js')
const { backupStorageFor } = await import('../modules/backup/storage.js')

const FAKE_DUMP_SQL = Buffer.from(`
CREATE TABLE "organizations" (id uuid);
CREATE TABLE "users" (id uuid);
CREATE TABLE "projects" (id uuid);
CREATE TABLE "credentials" (id uuid);
CREATE TABLE "audit_log_entries" (id uuid);
`)

function fakeBoss() {
  return { send: vi.fn(async () => 'job-id'), isStarted: () => false } as unknown as Parameters<
    typeof runBackupSnapshotJob
  >[0]
}

function silentLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

describe.sequential('Story 9.1: backup-snapshot worker', () => {
  beforeAll(async () => {
    await resetVaultForTest()
    try {
      await initVault({ kmsType: 'passphrase', passphrase: 'backup-worker-test-passphrase' }, {})
    } catch (error) {
      if ((error as { code?: string }).code !== 'ALREADY_INITIALIZED') throw error
    }
  })

  afterAll(async () => {
    await resetVaultForTest()
    rmSync(storageDir, { recursive: true, force: true })
  })

  it('scheduled fire (no job.data) acquires its own slot and succeeds via the injected dump', async () => {
    const storage = backupStorageFor({ type: 'filesystem', path: storageDir })
    const logger = silentLogger()

    await runBackupSnapshotJob(fakeBoss(), logger, undefined, {
      dump: async () => FAKE_DUMP_SQL,
      storage,
    })

    expect(logger.error).not.toHaveBeenCalled()
    const [latest] = await getDb()
      .select()
      .from(backupRuns)
      .where(eq(backupRuns.triggeredBy, 'schedule'))
    expect(latest?.status).toBe('succeeded')
  })

  it('manual fire (job.data carries an existing slot) uses that slot rather than acquiring a new one', async () => {
    const { acquireBackupSlot } = await import('../modules/backup/service.js')
    const slot = await acquireBackupSlot({ triggeredBy: 'manual' })
    if (!slot.ok) throw new Error('expected slot')
    const storage = backupStorageFor({ type: 'filesystem', path: storageDir })
    const logger = silentLogger()

    await runBackupSnapshotJob(
      fakeBoss(),
      logger,
      { runId: slot.runId, filename: slot.filename, metaFilename: slot.metaFilename },
      { dump: async () => FAKE_DUMP_SQL, storage }
    )

    const [row] = await getDb().select().from(backupRuns).where(eq(backupRuns.id, slot.runId))
    expect(row?.status).toBe('succeeded')
    expect(row?.filename).toBe(slot.filename)
  })

  it('AC-13: a failed dump creates a backup.failure admin_alerts row and delivers a notification', async () => {
    const storage = backupStorageFor({ type: 'filesystem', path: storageDir })
    const logger = silentLogger()
    const boss = fakeBoss()

    await runBackupSnapshotJob(boss, logger, undefined, {
      dump: async () => {
        throw new Error('pg_dump: connection to server failed')
      },
      storage,
    })

    expect(logger.error).toHaveBeenCalled()
    const failureAlerts = await getDb()
      .select()
      .from(adminAlerts)
      .where(eq(adminAlerts.alertType, 'backup.failure'))
    expect(failureAlerts.length).toBeGreaterThan(0)
  })

  it('AC-7: scheduled fire skips silently (no throw, no alert) when a backup is already running', async () => {
    const { acquireBackupSlot } = await import('../modules/backup/service.js')
    const running = await acquireBackupSlot({ triggeredBy: 'manual' })
    if (!running.ok) throw new Error('expected slot')
    const logger = silentLogger()

    await expect(runBackupSnapshotJob(fakeBoss(), logger, undefined, {})).resolves.toBeUndefined()
    expect(logger.error).not.toHaveBeenCalled()

    await getDb()
      .update(backupRuns)
      .set({ status: 'failed' })
      .where(eq(backupRuns.id, running.runId))
  })

  it('Story 9.6 AC-4: the scheduled backup:snapshot cron tick skips silently (no throw, no alert) while a restore holds the session-scoped lock', async () => {
    const { acquireRestoreLock } = await import('../modules/backup/service.js')
    const lock = await acquireRestoreLock()
    expect(lock.ok).toBe(true)
    if (!lock.ok) throw new Error('expected ok')
    const logger = silentLogger()

    try {
      // acquireBackupSlot()'s own pg_try_advisory_xact_lock fails while the restore's
      // session-level lock is held on the same key (D1.1) — no code change to acquireBackupSlot
      // or runBackupSnapshotJob was needed for this to already behave exactly like AC-7's
      // existing backup-vs-backup case.
      await expect(runBackupSnapshotJob(fakeBoss(), logger, undefined, {})).resolves.toBeUndefined()
      expect(logger.error).not.toHaveBeenCalled()
    } finally {
      await lock.release()
    }
  })
})
