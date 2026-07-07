import { OperationalEvent } from '@project-vault/shared'
import type { FastifyBaseLogger } from 'fastify'
import { operationalLog } from '../lib/logger.js'
import { pruneOldBackups, type BackupServiceDeps } from '../modules/backup/service.js'

type WorkerLogger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>

/**
 * Story 9.1 AC-11: retention pruning, run as a post-success step of the `backup:snapshot` job
 * (not its own cron schedule) — the AC documents either approach as acceptable ("as part of the
 * scheduled backup:snapshot job, after a successful new backup, or as its own periodic job");
 * running it immediately after every successful backup means retention never lags behind by a
 * full cron cycle, and keeps a single easy-to-reason-about "backup finished" code path.
 */
export async function runBackupRetentionPrune(
  logger?: WorkerLogger,
  deps: BackupServiceDeps = {}
): Promise<void> {
  const { prunedFilenames } = await pruneOldBackups(deps)
  if (logger && prunedFilenames.length > 0) {
    operationalLog(
      logger,
      'info',
      OperationalEvent.BACKUP_RETENTION_PRUNED,
      'backup retention pruned old backups',
      { prunedCount: prunedFilenames.length, prunedFilenames }
    )
  }
}
