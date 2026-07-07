import { OperationalEvent } from '@project-vault/shared'
import type { FastifyBaseLogger } from 'fastify'
import { env } from '../config/env.js'
import { operationalLog } from '../lib/logger.js'
import type { BossService } from '../lib/boss.js'
import { isBackupEnabled } from '../modules/backup/config.js'
import { lastSuccessfulBackupAt } from '../modules/backup/service.js'
import {
  createAdminAlertIfNotActive,
  deliverAdminAlertAcrossOrgs,
} from '../modules/backup/alerts.js'

type WorkerLogger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>

const MS_PER_HOUR = 60 * 60 * 1000
const BACKUP_MISSED_ALERT_TYPE = 'backup.missed'

function hoursSince(date: Date | null): number {
  if (!date) return Number.POSITIVE_INFINITY
  return (Date.now() - date.getTime()) / MS_PER_HOUR
}

/** Raises (or silently skips, if already active) the `backup.missed` alert and, only when a new
 * row was actually created, logs + delivers it across every org (D7). Split out of
 * runBackupHealthCheck purely to keep that function's cyclomatic complexity within this repo's
 * eslint threshold. */
async function raiseBackupMissedAlert(
  boss: BossService,
  logger: WorkerLogger | undefined,
  lastSuccess: Date | null,
  hoursSinceLastSuccess: number
): Promise<void> {
  const lastSuccessAt = lastSuccess ? lastSuccess.toISOString() : null
  const alert = await createAdminAlertIfNotActive({
    alertType: BACKUP_MISSED_ALERT_TYPE,
    severity: 'critical',
    payload: {
      lastSuccessAt,
      hoursSinceLastSuccess: Number.isFinite(hoursSinceLastSuccess)
        ? Math.round(hoursSinceLastSuccess)
        : null,
    },
  })
  if (!alert) return // AC-12: already active — never re-created while the condition persists.

  if (logger) {
    operationalLog(logger, 'error', OperationalEvent.BACKUP_MISSED, 'backup missed', {
      lastSuccessAt,
    })
  }
  await deliverAdminAlertAcrossOrgs(boss, BACKUP_MISSED_ALERT_TYPE, { lastSuccessAt })
}

/**
 * Story 9.1 AC-12: hourly `backup/health-check` — if the last *succeeded* backup completed more
 * than `BACKUP_MAX_AGE_HOURS` ago (or none has ever succeeded), creates a `backup.missed`
 * admin_alerts row (idempotent — `createAdminAlertIfNotActive` skips if one is already active)
 * and delivers it across every org (D7). A no-op entirely if backup isn't configured at all
 * (AC-15) — there is nothing meaningful to alert on for an instance that never opted in.
 */
export async function runBackupHealthCheck(
  boss: BossService,
  logger?: WorkerLogger
): Promise<void> {
  if (!isBackupEnabled()) return

  const lastSuccess = await lastSuccessfulBackupAt()
  const hoursSinceLastSuccess = hoursSince(lastSuccess)
  if (hoursSinceLastSuccess <= env.BACKUP_MAX_AGE_HOURS) return

  await raiseBackupMissedAlert(boss, logger, lastSuccess, hoursSinceLastSuccess)
}
