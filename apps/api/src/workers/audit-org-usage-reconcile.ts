import { eq, sql } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import { auditOrgStorageUsage } from '@project-vault/db/schema'
import { OperationalEvent } from '@project-vault/shared'
import { env } from '../config/env.js'
import { operationalLog } from '../lib/logger.js'
import { getAdminDb } from '../lib/db.js'
import { fetchAllOrgIds, runOrgScopedJob } from '../middleware/rls.js'
import {
  clearThresholdAlertEpisode,
  upsertThresholdAlert,
  type ThresholdPct,
} from '../lib/threshold-alerts.js'
import {
  createOrgAdminNotificationEntries,
  sendNotificationJobs,
} from '../notifications/dispatcher.js'
import type { BossService } from '../lib/boss.js'
import { PREAUTH_ATTRIBUTABLE_EVENT_TYPES } from '../modules/audit/quota-gate.js'
import { resolveEffectiveOrgQuotaBytes } from '../modules/audit/quota-config.js'

type WorkerLogger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>

const ORG_WARNING_ALERT_TYPE = 'audit_org_storage.warning'
const ORG_CRITICAL_ALERT_TYPE = 'audit_org_storage.critical'
const PREAUTH_VOLUME_ALERT_TYPE = 'audit_preauth_volume.high'

function thresholdFor(pct: number): ThresholdPct | null {
  if (pct >= 95) return 95
  if (pct >= 90) return 90
  if (pct >= 80) return 80
  return null
}

/**
 * Story 22.1 AC-17/AC-18 — per-org tiered alert at 80/90/95% of the org's OWN effective quota,
 * reusing `upsertThresholdAlert`'s episode idempotency with `scopeKey = orgId`, delivered to the
 * org's own admins (never platform-wide, never naming another org's figures — AC-18's info-leak
 * prohibition). An org with no configured quota (unlimited) has no utilization percentage and is
 * skipped, not treated as 0% or infinite (AC-17's divide-by-zero edge). Evaluated right after this
 * org's usage counters are (re)written by reconciliation, so the percentage is always computed
 * from freshly-written figures — not a separately-scheduled job, to keep this story's operational
 * surface to one job rather than two.
 */
async function evaluateOrgQuotaAlert(
  boss: BossService | undefined,
  orgId: string,
  bytesUsed: number,
  quota: number | null
): Promise<void> {
  if (quota === null || quota <= 0) {
    await clearThresholdAlertEpisode(ORG_WARNING_ALERT_TYPE, orgId)
    await clearThresholdAlertEpisode(ORG_CRITICAL_ALERT_TYPE, orgId)
    return
  }
  const utilizationPct = (bytesUsed / quota) * 100
  const thresholdPct = thresholdFor(utilizationPct)
  if (!thresholdPct) {
    await clearThresholdAlertEpisode(ORG_WARNING_ALERT_TYPE, orgId)
    await clearThresholdAlertEpisode(ORG_CRITICAL_ALERT_TYPE, orgId)
    return
  }
  const critical = thresholdPct === 95
  const alertType = critical ? ORG_CRITICAL_ALERT_TYPE : ORG_WARNING_ALERT_TYPE
  if (!critical) await clearThresholdAlertEpisode(ORG_CRITICAL_ALERT_TYPE, orgId)

  // AC-9's NF-14: the org may already be refusing writes below a naive "100%" reading, because
  // the rule is bytesUsed + n > quota, not bytesUsed > quota. The 95% payload is labelled
  // accordingly so a future display (Story 22.3) does not round it into a false sense of headroom.
  const payload = {
    bytesUsed,
    quotaBytes: quota,
    utilizationPct,
    ...(critical ? { mayAlreadyBeRefusingWrites: true } : {}),
  }
  const alert = await upsertThresholdAlert({
    alertType,
    thresholdPct,
    severity: critical ? 'critical' : 'warning',
    payload,
    scopeKey: orgId,
  })
  if (!alert || !boss) return

  const jobs = await runOrgScopedJob(orgId, 'audit-org-usage/reconcile-alert', ({ tx }) =>
    createOrgAdminNotificationEntries({
      orgId,
      tx,
      template: {
        templateId: alertType,
        severity: critical ? 'critical' : 'warning',
        payload: {
          ...payload,
          message: `Audit storage at ${utilizationPct.toFixed(0)}% of your organization's quota. Reduce retention or enable audit forwarding to reclaim space.`,
        },
      },
    })
  )
  await sendNotificationJobs(boss, jobs)
}

/** AC-29 — an operator alert (never org-facing: this volume is never attributable to a single
 * victim org's quota) when total instance-wide pre-auth-attributable volume crosses the
 * configured threshold. `0` (the default) disables the alert. Computed from the reconciliation
 * aggregate's own rows — no additional query, and no additional getAdminDb() call site beyond
 * the one AC-8 already justifies for the aggregate itself. */
async function checkPreauthVolumeAlert(rows: ReconcileAggregateRow[]): Promise<void> {
  if (env.AUDIT_ORG_PREAUTH_ALERT_THRESHOLD_MB <= 0) return
  const totalBytes = rows.reduce((sum, row) => sum + Number(row.preauth_logical_bytes ?? 0), 0)
  const thresholdBytes = env.AUDIT_ORG_PREAUTH_ALERT_THRESHOLD_MB * 1024 * 1024
  if (totalBytes < thresholdBytes) {
    await clearThresholdAlertEpisode(PREAUTH_VOLUME_ALERT_TYPE, null)
    return
  }
  await upsertThresholdAlert({
    alertType: PREAUTH_VOLUME_ALERT_TYPE,
    thresholdPct: 80,
    severity: 'warning',
    payload: { totalBytes, thresholdBytes },
    scopeKey: null,
  })
}

const RECONCILE_FAILING_ALERT_TYPE = 'audit_usage_reconciliation.failing'

/** AC-7: a reconciliation write-back that moves a counter by more than this many bytes emits an
 * operational drift log (before/after values) so an operator can see the daily-check-style
 * "cost is visible" signal for THIS job too. */
const DRIFT_LOG_TOLERANCE_BYTES = 1_048_576 // 1 MiB

type ReconcileAggregateRow = {
  org_id: string
  logical_bytes: string | null
  preauth_logical_bytes: string | null
  entries: string
}

/**
 * Story 22.1 AC-7 — ONE partitioned scan for the whole instance (never one scan per org). The
 * pre-auth classification is a BOUND PARAMETER built from PREAUTH_ATTRIBUTABLE_EVENT_TYPES at
 * call time (`Array.from(...)`), never a re-typed SQL literal list (NF-10) — this is what keeps
 * the write path's and reconciliation's classification impossible to drift apart.
 */
async function runReconcileAggregate(
  timeoutMs: number
): Promise<{ rows: ReconcileAggregateRow[]; preauthTypesParam: string[] }> {
  const preauthTypesParam = Array.from(PREAUTH_ATTRIBUTABLE_EVENT_TYPES)
  // drizzle-orm's sql`` tag spreads a plain JS array into a comma-separated tuple ($1, $2, ...),
  // which is valid SQL for `IN (...)` but not for `= ANY(...)` (which requires an actual Postgres
  // array value). Build a real `ARRAY[...]::text[]` literal from individually-bound elements
  // instead — still one bound parameter per element (never a re-typed SQL literal, NF-10), just
  // wrapped so Postgres sees an array.
  const preauthTypesArrayLiteral = sql`ARRAY[${sql.join(
    preauthTypesParam.map((eventType) => sql`${eventType}`),
    sql`, `
  )}]::text[]`
  const rows = await getAdminDb().transaction(async (tx) => {
    // SET LOCAL scopes the timeout to this transaction only — it is not a session-wide change on
    // a pooled connection.
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${Number(timeoutMs)}`))
    return tx.execute<ReconcileAggregateRow>(sql`
      SELECT org_id,
             sum(pg_column_size(t.*)) FILTER (WHERE NOT (t.event_type = ANY(${preauthTypesArrayLiteral})))::bigint AS logical_bytes,
             sum(pg_column_size(t.*)) FILTER (WHERE t.event_type = ANY(${preauthTypesArrayLiteral}))::bigint AS preauth_logical_bytes,
             count(*)::bigint AS entries
        FROM audit_log_entries t
       GROUP BY org_id
    `)
  })
  return { rows, preauthTypesParam }
}

async function writeBackOneOrg(
  row: ReconcileAggregateRow,
  logger: WorkerLogger | undefined,
  boss: BossService | undefined
): Promise<void> {
  const bytesUsed = Number(row.logical_bytes ?? 0)
  const preauthBytesUsed = Number(row.preauth_logical_bytes ?? 0)
  const entryCount = Number(row.entries)
  const now = new Date()

  await runOrgScopedJob(row.org_id, 'audit-org-usage-reconcile', async ({ tx }) => {
    const [current] = await tx
      .select({ bytesUsed: auditOrgStorageUsage.bytesUsed })
      .from(auditOrgStorageUsage)
      .where(eq(auditOrgStorageUsage.orgId, row.org_id))

    if (current && Math.abs(current.bytesUsed - bytesUsed) > DRIFT_LOG_TOLERANCE_BYTES && logger) {
      operationalLog(
        logger,
        'warn',
        OperationalEvent.AUDIT_ORG_USAGE_RECONCILE_DRIFT,
        'audit-org-usage-reconcile: counter drift exceeded tolerance',
        { orgId: row.org_id, before: current.bytesUsed, after: bytesUsed }
      )
    }

    await tx
      .insert(auditOrgStorageUsage)
      .values({
        orgId: row.org_id,
        bytesUsed,
        preauthBytesUsed,
        entryCount,
        lastReconciledAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: auditOrgStorageUsage.orgId,
        set: { bytesUsed, preauthBytesUsed, entryCount, lastReconciledAt: now, updatedAt: now },
      })

    const quota = await resolveEffectiveOrgQuotaBytes(tx, row.org_id)
    await evaluateOrgQuotaAlert(boss, row.org_id, bytesUsed, quota)
  })
}

const STALE_USAGE_ALERT_TYPE = 'audit_usage_reconciliation.failing'

/** AC-7 — any org whose `last_reconciled_at` is older than
 * `AUDIT_ORG_USAGE_STALE_AFTER_HOURS` (default 240h = 10 days) is flagged stale. The operator
 * surface that renders the per-org `stale` state ships in Story 22.3; this worker is only
 * responsible for raising the alert. AC-8 permits exactly ONE getAdminDb() bypass call site for
 * this worker — the reconciliation aggregate in `runReconcileAggregate` — so staleness detection
 * instead reuses the same RLS-safe `fetchAllOrgIds()` + per-org `runOrgScopedJob()` iteration
 * pattern already used by `writeBackAllOrgs` and every other cross-org worker in this codebase
 * (see `middleware/rls.ts`), rather than a second cross-org admin-bypass scan.
 */
/** Per-org staleness check for one org, isolated from the rest of the loop: a failure here is
 * logged and treated as "not stale" for this run rather than aborting the whole scan. */
async function isOrgUsageStale(
  orgId: string,
  staleCutoff: number,
  logger: WorkerLogger | undefined
): Promise<boolean> {
  try {
    const [row] = await runOrgScopedJob(orgId, 'audit-org-usage-reconcile/stale-check', ({ tx }) =>
      tx
        .select({ lastReconciledAt: auditOrgStorageUsage.lastReconciledAt })
        .from(auditOrgStorageUsage)
        .where(eq(auditOrgStorageUsage.orgId, orgId))
    )
    const lastReconciledAt = row?.lastReconciledAt ?? null
    return !lastReconciledAt || lastReconciledAt.getTime() < staleCutoff
  } catch (error) {
    if (logger) {
      operationalLog(
        logger,
        'error',
        OperationalEvent.AUDIT_ORG_USAGE_RECONCILE_ORG_WRITEBACK_FAILED,
        'audit-org-usage-reconcile: one org stale-check failed — continuing with the rest',
        { orgId, err: error instanceof Error ? error.message : String(error) }
      )
    }
    return false
  }
}

async function checkStaleOrgs(logger: WorkerLogger | undefined): Promise<void> {
  const staleAfterMs = env.AUDIT_ORG_USAGE_STALE_AFTER_HOURS * 60 * 60 * 1000
  const staleCutoff = Date.now() - staleAfterMs
  const orgIds = await fetchAllOrgIds()

  let staleCount = 0
  for (const orgId of orgIds) {
    if (await isOrgUsageStale(orgId, staleCutoff, logger)) {
      staleCount += 1
    }
  }
  if (staleCount === 0) return
  if (logger) {
    operationalLog(
      logger,
      'warn',
      OperationalEvent.AUDIT_ORG_USAGE_RECONCILE_FAILED,
      'audit-org-usage-reconcile: orgs with stale usage counters found',
      { staleCount, staleAfterHours: env.AUDIT_ORG_USAGE_STALE_AFTER_HOURS }
    )
  }
  await upsertThresholdAlert({
    alertType: STALE_USAGE_ALERT_TYPE,
    thresholdPct: 80,
    severity: 'warning',
    payload: { staleCount, staleAfterHours: env.AUDIT_ORG_USAGE_STALE_AFTER_HOURS },
    scopeKey: null,
  })
}

async function handleAggregateFailure(
  error: unknown,
  logger: WorkerLogger | undefined
): Promise<never> {
  if (logger) {
    operationalLog(
      logger,
      'error',
      OperationalEvent.AUDIT_ORG_USAGE_RECONCILE_FAILED,
      'audit-org-usage-reconcile: aggregate failed or timed out — no partial writes',
      { err: error instanceof Error ? error.message : String(error) }
    )
  }
  await upsertThresholdAlert({
    alertType: RECONCILE_FAILING_ALERT_TYPE,
    thresholdPct: 95,
    severity: 'critical',
    payload: { err: error instanceof Error ? error.message : String(error) },
    scopeKey: null,
  })
  throw error
}

/** Per-org write-back isolation: returns the count of orgs successfully updated, one bad org's
 * failure is logged and never blocks the rest of the loop. */
async function writeBackAllOrgs(
  rows: ReconcileAggregateRow[],
  logger: WorkerLogger | undefined,
  boss: BossService | undefined
): Promise<number> {
  let orgsUpdated = 0
  for (const row of rows) {
    try {
      await writeBackOneOrg(row, logger, boss)
      orgsUpdated += 1
    } catch (error) {
      if (logger) {
        operationalLog(
          logger,
          'error',
          OperationalEvent.AUDIT_ORG_USAGE_RECONCILE_ORG_WRITEBACK_FAILED,
          'audit-org-usage-reconcile: one org write-back failed — continuing with the rest',
          { orgId: row.org_id, err: error instanceof Error ? error.message : String(error) }
        )
      }
    }
  }
  return orgsUpdated
}

function logRunCompleted(
  logger: WorkerLogger | undefined,
  durationMs: number,
  rowsScanned: number,
  orgsUpdated: number
): void {
  if (!logger) return
  operationalLog(
    logger,
    'info',
    OperationalEvent.AUDIT_ORG_USAGE_RECONCILE_COMPLETED,
    'audit-org-usage-reconcile: run completed',
    { durationMs, rowsScanned, orgsUpdated }
  )
  if (durationMs > env.AUDIT_ORG_USAGE_RECONCILE_TIMEOUT_MS * 0.5) {
    operationalLog(
      logger,
      'warn',
      OperationalEvent.AUDIT_ORG_USAGE_RECONCILE_COMPLETED,
      'audit-org-usage-reconcile: run exceeded 50% of its statement_timeout budget — see docs/operations/audit-log-scaling.md',
      { durationMs, timeoutMs: env.AUDIT_ORG_USAGE_RECONCILE_TIMEOUT_MS }
    )
  }
}

/**
 * Story 22.1 AC-7 — weekly (default `0 5 * * 0`) usage reconciliation, on its own schedule,
 * separate from the daily audit-storage/check job. Corrects drift; the INCREMENTAL counters (the
 * gate statement in quota-gate.ts), not this job, are the enforcement source of truth between
 * runs. Per-org write-back failures are isolated (one bad org never blocks another's); a
 * statement_timeout abort writes nothing partial and raises an operator alert. No chunked or
 * incremental fallback is added deliberately — the documented escalation when this stops fitting
 * its budget is the table-partitioning step in docs/operations/audit-log-scaling.md, and the
 * immediate remedy is the AC-25 kill switch.
 */
export async function runAuditOrgUsageReconcile(
  logger?: WorkerLogger,
  boss?: BossService
): Promise<void> {
  const startedAt = Date.now()
  const aggregate = await runReconcileAggregate(env.AUDIT_ORG_USAGE_RECONCILE_TIMEOUT_MS).catch(
    (error: unknown) => handleAggregateFailure(error, logger)
  )

  const orgsUpdated = await writeBackAllOrgs(aggregate.rows, logger, boss)

  const durationMs = Date.now() - startedAt
  logRunCompleted(logger, durationMs, aggregate.rows.length, orgsUpdated)

  await checkStaleOrgs(logger)
  await checkPreauthVolumeAlert(aggregate.rows)
}
