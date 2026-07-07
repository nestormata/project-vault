import { OperationalEvent } from '@project-vault/shared'
import { sql } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import { env } from '../config/env.js'
import { operationalLog } from '../lib/logger.js'
import { getAdminDb } from '../lib/db.js'
import type { BossService } from '../lib/boss.js'
import { clearThresholdAlertEpisode, upsertThresholdAlert } from '../lib/threshold-alerts.js'
import { deliverAdminAlertAcrossOrgs } from '../modules/backup/alerts.js'

type WorkerLogger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>

const WARNING_ALERT_TYPE = 'audit_storage.warning'
const CRITICAL_ALERT_TYPE = 'audit_storage.critical'
const TOP_CONTRIBUTORS_WINDOW_HOURS = 24
const TOP_CONTRIBUTORS_LIMIT = 5

type TopContributor = { orgId: string; bytesAdded: number; rowsAdded: number }

async function wasMaintenanceModeActive(): Promise<boolean> {
  const rows = await getAdminDb().execute<{ id: string }>(sql`
    SELECT id FROM admin_alerts WHERE alert_type = ${CRITICAL_ALERT_TYPE} AND status = 'active' LIMIT 1
  `)
  return rows.length > 0
}

/**
 * D10/AC-17: per-org storage-growth breakdown since the last check (approximated as rows written
 * in the last `TOP_CONTRIBUTORS_WINDOW_HOURS`, matching the daily check cadence) — converts an
 * aggregate storage-pressure alert from "silent and unattributable" into "immediately
 * diagnosable" without ad hoc SQL. `bytesAdded` is an estimate (this table's average row size,
 * derived from its own total size / total row count, times that org's row growth) — the exact
 * per-row byte size is not tracked, and an estimate is more honest than omitting the field
 * entirely while still being clearly documented as such.
 */
async function computeTopContributingOrgs(currentBytes: number): Promise<TopContributor[]> {
  const admin = getAdminDb()
  const [totalRow] = await admin.execute<{ total: string }>(
    sql`SELECT count(*)::text AS total FROM audit_log_entries`
  )
  const totalRows = Number(totalRow?.total ?? 0)
  const avgBytesPerRow = totalRows > 0 ? currentBytes / totalRows : 0

  const growthRows = await admin.execute<{ org_id: string; rows_added: string }>(sql`
    SELECT org_id, count(*)::text AS rows_added
    FROM audit_log_entries
    WHERE created_at > now() - (${TOP_CONTRIBUTORS_WINDOW_HOURS}::text || ' hours')::interval
    GROUP BY org_id
    ORDER BY count(*) DESC
    LIMIT ${TOP_CONTRIBUTORS_LIMIT}
  `)

  return growthRows.map((row) => {
    const rowsAdded = Number(row.rows_added)
    return {
      orgId: row.org_id,
      rowsAdded,
      bytesAdded: Math.round(rowsAdded * avgBytesPerRow),
    }
  })
}

type Utilization = { currentBytes: number; limitBytes: number; utilizationPct: number }

/** `limitGbOverride` exists purely so tests can force a "healthy" or "critical" utilization
 * reading deterministically without depending on the real audit_log_entries table's actual size
 * or reimporting env.ts with different process.env state — production call sites never pass it,
 * always using the real env.AUDIT_LOG_STORAGE_LIMIT_GB. */
async function computeUtilization(limitGbOverride?: number): Promise<Utilization> {
  const [sizeRow] = await getAdminDb().execute<{ size: string }>(
    sql`SELECT pg_total_relation_size('audit_log_entries')::text AS size`
  )
  const currentBytes = Number(sizeRow?.size ?? 0)
  const limitBytes = (limitGbOverride ?? env.AUDIT_LOG_STORAGE_LIMIT_GB) * 1024 ** 3
  const utilizationPct = limitBytes > 0 ? (currentBytes / limitBytes) * 100 : 0
  return { currentBytes, limitBytes, utilizationPct }
}

/** Below 80% — clears any prior episode and logs a maintenance-mode-exited transition. */
async function handleHealthyUtilization(
  utilization: Utilization,
  wasActive: boolean,
  logger?: WorkerLogger
): Promise<void> {
  await clearThresholdAlertEpisode(WARNING_ALERT_TYPE, null)
  await clearThresholdAlertEpisode(CRITICAL_ALERT_TYPE, null)
  if (wasActive && logger) {
    operationalLog(
      logger,
      'warn',
      OperationalEvent.AUDIT_STORAGE_MAINTENANCE_MODE_EXITED,
      'audit storage maintenance mode exited — utilization dropped below 95%',
      utilization
    )
  }
}

function logMaintenanceModeEnteredIfNewlyActive(
  wasActive: boolean,
  critical: boolean,
  utilization: Utilization,
  logger?: WorkerLogger
): void {
  if (wasActive || !critical || !logger) return
  operationalLog(
    logger,
    'warn',
    OperationalEvent.AUDIT_STORAGE_MAINTENANCE_MODE_ENTERED,
    'audit storage maintenance mode entered — utilization at or above 95%',
    utilization
  )
}

/** At or above 80% — raises/escalates the appropriate tiered alert and fans it out. */
async function handleElevatedUtilization(
  boss: BossService,
  utilization: Utilization,
  wasActive: boolean,
  logger?: WorkerLogger
): Promise<void> {
  const { currentBytes, utilizationPct } = utilization
  const critical = utilizationPct >= 95
  const alertType = critical ? CRITICAL_ALERT_TYPE : WARNING_ALERT_TYPE
  const thresholdPct = critical ? 95 : utilizationPct >= 90 ? 90 : 80
  const topContributingOrgs =
    thresholdPct >= 90 ? await computeTopContributingOrgs(currentBytes) : undefined

  if (!critical) await clearThresholdAlertEpisode(CRITICAL_ALERT_TYPE, null)

  const payload = { ...utilization, topContributingOrgs }
  const alert = await upsertThresholdAlert({
    alertType,
    thresholdPct,
    severity: critical ? 'critical' : 'warning',
    payload,
    scopeKey: null,
  })

  logMaintenanceModeEnteredIfNewlyActive(wasActive, critical, utilization, logger)

  if (alert) {
    await deliverAdminAlertAcrossOrgs(boss, alertType, payload, critical ? 'critical' : 'warning')
  }
}

/**
 * Story 9.2 D5/AC-15 through AC-17: daily `audit-storage/check` job.
 *
 * D5: queries `pg_total_relation_size('audit_log_entries')` — the REAL table (epics.md's literal
 * 'audit_events' has never existed in this codebase). Do not "correct" this to 'audit_events'.
 *
 * AC-16: tiered alerts at 80/90/95% (idempotent per-threshold via upsertThresholdAlert), fanned
 * out to every org (audit storage affects every org's ability to write audit entries, D7).
 *
 * AC-17: at >=95%, the `audit_storage.critical` admin_alerts row IS the maintenance-mode flag
 * (maintenance-mode.ts checks it directly) — entering/exiting is logged distinctly from the
 * routine "still elevated" no-op case.
 *
 * Fails safe (AC-17 edge case): if this job itself errors, maintenance mode (if active) is left
 * untouched (better to keep suspending non-critical audit writes than to guess), but the failure
 * is logged at `error` level so it surfaces in operational monitoring.
 */
export async function runAuditStorageCheck(
  boss: BossService,
  logger?: WorkerLogger,
  /** Test-only override — see computeUtilization()'s doc comment. */
  limitGbOverride?: number
): Promise<void> {
  try {
    const wasActive = await wasMaintenanceModeActive()
    const utilization = await computeUtilization(limitGbOverride)

    if (utilization.utilizationPct < 80) {
      await handleHealthyUtilization(utilization, wasActive, logger)
      return
    }

    await handleElevatedUtilization(boss, utilization, wasActive, logger)
  } catch (error) {
    if (logger) {
      operationalLog(
        logger,
        'error',
        OperationalEvent.AUDIT_STORAGE_CHECK_FAILED,
        'audit-storage/check job failed',
        { err: error instanceof Error ? { message: error.message, stack: error.stack } : error }
      )
    }
    throw error
  }
}
