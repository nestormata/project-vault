import { OperationalEvent } from '@project-vault/shared'
import type { FastifyBaseLogger } from 'fastify'
import type { BossService, BossJob } from '../lib/boss.js'
import { operationalLog } from '../lib/logger.js'
import { VaultSealedError } from '../modules/vault/key-service.js'
import {
  acquireBackupSlot,
  executeBackupSnapshot,
  type BackupServiceDeps,
} from '../modules/backup/service.js'
import { reportBackupFailureAlert } from '../modules/backup/routes.js'
import { runBackupRetentionPrune } from './backup-retention.js'

type WorkerLogger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>

type BackupSnapshotJobData = {
  runId?: string
  filename?: string
  metaFilename?: string
}

/**
 * Story 9.1 AC-5/AC-7: entry point for the `backup/snapshot` pg-boss job — fired either by the
 * cron schedule (job.data is empty; this worker acquires its own slot with `triggeredBy:
 * 'schedule'`) or by `POST /admin/backup/trigger` (job.data already carries the runId/filename
 * the route's own `acquireBackupSlot` call reserved, `triggeredBy: 'manual'`).
 */
export async function runBackupSnapshotJob(
  boss: BossService,
  logger: WorkerLogger,
  jobData?: BackupSnapshotJobData,
  deps: BackupServiceDeps = {}
): Promise<void> {
  let slot: { runId: string; filename: string; metaFilename: string }

  if (jobData?.runId && jobData.filename && jobData.metaFilename) {
    slot = { runId: jobData.runId, filename: jobData.filename, metaFilename: jobData.metaFilename }
  } else {
    const acquired = await acquireBackupSlot({ triggeredBy: 'schedule' })
    if (!acquired.ok) {
      // AC-7: a scheduled fire coinciding with an already-running backup (manual or a previous
      // scheduled run still in flight) is not an error — just skip this tick silently.
      return
    }
    slot = acquired
  }

  try {
    const result = await executeBackupSnapshot(slot, deps)
    operationalLog(logger, 'info', OperationalEvent.BACKUP_COMPLETED, 'backup completed', {
      filename: slot.filename,
      sizeBytes: result.sizeBytes,
      durationMs: result.durationMs,
    })
    await runBackupRetentionPrune(logger, deps)
  } catch (error) {
    // AC-5: belt-and-suspenders — pg-boss workers are only started onVaultUnsealed (main.ts's
    // existing pattern), so this job cannot normally fire while sealed; this guard exists purely
    // for a hot-reload/dev-restart race where it somehow does.
    const reason = error instanceof VaultSealedError ? 'vault_sealed' : undefined
    const message = error instanceof Error ? error.message : String(error)
    await reportBackupFailureAlert(boss, logger, {
      filename: slot.filename,
      errorMessage: message,
      reason,
    })
  }
}

export function backupSnapshotHandler(boss: BossService, logger: WorkerLogger) {
  return (job: BossJob) => runBackupSnapshotJob(boss, logger, job.data as BackupSnapshotJobData)
}
