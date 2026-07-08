import { and, eq } from 'drizzle-orm'
import { OperationalEvent } from '@project-vault/shared'
import type { FastifyBaseLogger } from 'fastify'
import { getDb } from '@project-vault/db'
import { adminAlerts } from '@project-vault/db/schema'
import { env } from '../config/env.js'
import { operationalLog, serializeLogError } from '../lib/logger.js'
import { clearThresholdAlertEpisode } from '../lib/threshold-alerts.js'
import type { BossService } from '../lib/boss.js'
import { isBackupEnabled } from '../modules/backup/config.js'
import { lastSuccessfulBackupAt } from '../modules/backup/service.js'
import {
  createAdminAlertIfNotActive,
  deliverAdminAlertAcrossOrgs,
} from '../modules/backup/alerts.js'

type WorkerLogger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>

export type BackupHealthCheckDeps = {
  /** Test-only override for the healthy-branch alert-resolve step (D2) — production always uses
   * `clearThresholdAlertEpisode('backup.missed', null)` (Story 9.2, unmodified). Lets tests
   * exercise D2's failure-isolation try/catch (adversarial review, high) without needing a
   * genuine DB failure. */
  clearBackupMissedAlert?: () => Promise<void>
}

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
 * Story 9.6 D2/AC-8 through AC-11: auto-resolves the `backup.missed` alert once backups are
 * healthy again, reusing Story 9.2's already-shipped `clearThresholdAlertEpisode` unmodified — no
 * migration, no new status value. Checks for an active row FIRST (rather than calling
 * `clearThresholdAlertEpisode` unconditionally) purely so the `BACKUP_MISSED_RESOLVED` log (AC-11)
 * is only emitted when a row genuinely transitioned, not on every healthy tick — AC-9's own
 * documented idempotency note ("no error, no-op, no duplicate work") already accepts the narrow
 * race between this check and a concurrent tick's own resolve.
 *
 * D2 failure isolation (adversarial review, high): wrapped in its own try/catch, independent of
 * Task 3.4's orphan-cleanup/disk-pressure scan — a filesystem error in that unrelated scan must
 * never prevent this alert-resolve logic from running, and vice versa. This is the operator's
 * single most important reliability signal from this job.
 */
async function resolveBackupMissedAlertIfActive(
  logger: WorkerLogger | undefined,
  deps: BackupHealthCheckDeps
): Promise<void> {
  try {
    const [active] = await getDb()
      .select({ id: adminAlerts.id })
      .from(adminAlerts)
      .where(
        and(eq(adminAlerts.alertType, BACKUP_MISSED_ALERT_TYPE), eq(adminAlerts.status, 'active'))
      )
      .limit(1)
    if (!active) return // AC-9 edge: nothing active — no-op, not an error.

    const clear =
      deps.clearBackupMissedAlert ??
      (() => clearThresholdAlertEpisode(BACKUP_MISSED_ALERT_TYPE, null))
    await clear()

    // AC-11: operational log only — no notification is delivered for a resolution, unlike the
    // original "missed" alert (which IS notification-worthy, via deliverAdminAlertAcrossOrgs above).
    if (logger) {
      operationalLog(
        logger,
        'info',
        OperationalEvent.BACKUP_MISSED_RESOLVED,
        'backup missed alert resolved',
        {}
      )
    }
  } catch (error) {
    if (logger) {
      operationalLog(
        logger,
        'error',
        OperationalEvent.BACKUP_MISSED_RESOLVE_FAILED,
        'backup missed alert resolve failed',
        { err: serializeLogError(error) }
      )
    }
  }
}

/**
 * Story 9.1 AC-12: hourly `backup/health-check` — if the last *succeeded* backup completed more
 * than `BACKUP_MAX_AGE_HOURS` ago (or none has ever succeeded), creates a `backup.missed`
 * admin_alerts row (idempotent — `createAdminAlertIfNotActive` skips if one is already active)
 * and delivers it across every org (D7). A no-op entirely if backup isn't configured at all
 * (AC-15) — there is nothing meaningful to alert on for an instance that never opted in.
 *
 * Story 9.6 D2: when healthy, auto-resolves any active `backup.missed` alert instead of just
 * silently returning (see `resolveBackupMissedAlertIfActive` above).
 */
export async function runBackupHealthCheck(
  boss: BossService,
  logger?: WorkerLogger,
  deps: BackupHealthCheckDeps = {}
): Promise<void> {
  if (!isBackupEnabled()) return

  const lastSuccess = await lastSuccessfulBackupAt()
  const hoursSinceLastSuccess = hoursSince(lastSuccess)

  if (hoursSinceLastSuccess <= env.BACKUP_MAX_AGE_HOURS) {
    await resolveBackupMissedAlertIfActive(logger, deps)
    return
  }

  await raiseBackupMissedAlert(boss, logger, lastSuccess, hoursSinceLastSuccess)
}
