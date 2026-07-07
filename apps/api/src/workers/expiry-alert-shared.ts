import type { FastifyBaseLogger } from 'fastify'
import type { NotificationSeverity } from '@project-vault/shared'
import { OperationalEvent } from '@project-vault/shared'
import type { BossService } from '../lib/boss.js'
import { fetchAllOrgIds, runOrgScopedJob } from '../middleware/rls.js'
import {
  createOrgAdminNotificationEntries,
  sendNotificationJobs,
  type NotificationQueueJob,
} from '../notifications/dispatcher.js'
import { operationalLog, serializeLogError } from '../lib/logger.js'
import type { Tx } from '@project-vault/db'

const MS_PER_DAY = 86_400_000
const MATCH_TOLERANCE_DAYS = 1

/**
 * Whole days remaining until `expiryDate`, rounded up (a few hours past midnight still counts
 * as "that day"). Negative once the asset is overdue.
 */
export function computeDaysRemaining(expiryDate: Date, now: Date): number {
  return Math.ceil((expiryDate.getTime() - now.getTime()) / MS_PER_DAY)
}

/** AC 5: daysRemaining <= 3 -> critical, <= 7 -> warning, else info. */
export function severityForDaysRemaining(daysRemaining: number): NotificationSeverity {
  if (daysRemaining <= 3) return 'critical'
  if (daysRemaining <= 7) return 'warning'
  return 'info'
}

/** ISO-formats an optional expiry/renewal date for a notification payload, or null if unset. */
export function formatExpiryDate(date: Date | null | undefined): string | null {
  return date?.toISOString() ?? null
}

/** The daysRemaining/threshold/overdue fields every expiry-alert payload shares. */
export function baseExpiryPayload(context: {
  daysRemaining: number
  threshold: number
  overdue: boolean
}): { daysRemaining: number; threshold: number; overdue: boolean } {
  return {
    daysRemaining: context.daysRemaining,
    threshold: context.threshold,
    overdue: context.overdue,
  }
}

export type ExpiryAlertFiring = {
  threshold: number
  severity: NotificationSeverity
  overdue: boolean
}

export type ExpiryAlertResult = {
  firings: ExpiryAlertFiring[]
  nextNotifiedLeadDays: number[]
}

/**
 * Pure decision function for AC 5/11 — no DB access, fully unit-testable. Given the asset's
 * current daysRemaining and its alertLeadDays/notifiedLeadDays jsonb arrays, decides which
 * thresholds should fire this run and the notifiedLeadDays value the caller must persist
 * (in the same transaction as any notification-queue insert) to prevent re-firing.
 *
 * Overdue handling (pre-mortem finding): alertLeadDays are always positive, so the +/-1 day
 * match window never catches an asset whose expiry has already passed by more than a day.
 * We additionally fire once, as `threshold: 0, overdue: true`, whenever daysRemaining <= 0 and
 * 0 has not already been notified — this can coexist with a normal positive-threshold firing
 * on the same day (e.g. daysRemaining === 0 with alertLeadDays including 1).
 */
export function computeExpiryAlertFirings(params: {
  daysRemaining: number
  alertLeadDays: number[]
  notifiedLeadDays: number[]
}): ExpiryAlertResult {
  const { daysRemaining, alertLeadDays, notifiedLeadDays } = params
  const firings: ExpiryAlertFiring[] = []
  const nextNotifiedLeadDays = [...notifiedLeadDays]

  for (const threshold of alertLeadDays) {
    if (nextNotifiedLeadDays.includes(threshold)) continue
    if (Math.abs(daysRemaining - threshold) > MATCH_TOLERANCE_DAYS) continue
    firings.push({ threshold, severity: severityForDaysRemaining(daysRemaining), overdue: false })
    nextNotifiedLeadDays.push(threshold)
  }

  if (daysRemaining <= 0 && !nextNotifiedLeadDays.includes(0)) {
    firings.push({ threshold: 0, severity: 'critical', overdue: true })
    nextNotifiedLeadDays.push(0)
  }

  return { firings, nextNotifiedLeadDays }
}

export type WorkerLogger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>

/** The subset of a monitoring-record row that the shared job runner needs to operate on. */
export type ExpiryAlertRow = {
  id: string
  projectId: string
  alertLeadDays: number[]
  notifiedLeadDays: number[]
}

export type ExpiryAlertJobConfig<Row extends ExpiryAlertRow> = {
  /** e.g. 'cert/expiry-alert' — also passed through to runOrgScopedJob. */
  jobName: string
  templateId: string
  /** Short label used in operational log context (e.g. 'certificate', 'domain_record'). */
  assetType: string
  /** Human label used in log messages (e.g. 'certificate', 'domain', 'payment'). */
  assetLabel: string
  /** Fetches every row for the org that has a non-null expiry/renewal date, org-scoped. */
  fetchRows: (orgId: string) => Promise<Row[]>
  getExpiryDate: (row: Row) => Date | null
  buildPayload: (
    row: Row,
    context: { daysRemaining: number; threshold: number; overdue: boolean }
  ) => Record<string, unknown>
  updateNotifiedLeadDays: (tx: Tx, rowId: string, nextNotifiedLeadDays: number[]) => Promise<void>
}

/**
 * Matches, dispatches, and persists notifiedLeadDays for a single row inside its own
 * org-scoped transaction (AC 5 failure isolation: one row's failure must not abort the batch,
 * and the notification-queue insert + notifiedLeadDays update must commit together).
 */
async function processExpiryAlertRow<Row extends ExpiryAlertRow>(
  orgId: string,
  row: Row,
  now: Date,
  config: ExpiryAlertJobConfig<Row>
): Promise<NotificationQueueJob[]> {
  const expiryDate = config.getExpiryDate(row)
  if (!expiryDate) return []
  const daysRemaining = computeDaysRemaining(expiryDate, now)
  const { firings, nextNotifiedLeadDays } = computeExpiryAlertFirings({
    daysRemaining,
    alertLeadDays: row.alertLeadDays,
    notifiedLeadDays: row.notifiedLeadDays,
  })
  if (firings.length === 0) return []

  return runOrgScopedJob(orgId, config.jobName, async ({ tx }) => {
    const jobs: NotificationQueueJob[] = []
    for (const firing of firings) {
      const entries = await createOrgAdminNotificationEntries({
        orgId,
        tx,
        template: {
          templateId: config.templateId,
          severity: firing.severity,
          payload: config.buildPayload(row, {
            daysRemaining,
            threshold: firing.threshold,
            overdue: firing.overdue,
          }),
        },
      })
      jobs.push(...entries)
    }
    await config.updateNotifiedLeadDays(tx, row.id, nextNotifiedLeadDays)
    return jobs
  })
}

/**
 * Shared org-fan-out/failure-isolation loop for the cert/domain/payment expiry-alert workers
 * (AC 5): iterates every org, fetches its rows, and processes each row independently so a
 * single row or org failure never aborts the whole daily run. Each worker only supplies the
 * asset-specific table access, payload shape, and identifiers via `config`.
 */
export async function runExpiryAlertJob<Row extends ExpiryAlertRow>(
  boss: BossService,
  logger: WorkerLogger | undefined,
  config: ExpiryAlertJobConfig<Row>
): Promise<void> {
  const now = new Date()
  const orgIds = await fetchAllOrgIds()
  const allJobs: NotificationQueueJob[] = []

  for (const orgId of orgIds) {
    // AC 5 failure isolation: a failure fetching one org's rows (transient DB error, RLS
    // context issue) must not abort the whole job and silently skip every subsequent org's
    // alerts for the day — so the fetch itself is inside the per-org try/catch, not just the
    // per-row processing below.
    try {
      const rows = await config.fetchRows(orgId)

      for (const row of rows) {
        try {
          const jobs = await processExpiryAlertRow(orgId, row, now, config)
          allJobs.push(...jobs)
        } catch (error) {
          if (logger) {
            operationalLog(
              logger,
              'error',
              OperationalEvent.MONITORING_EXPIRY_ALERT_ROW_FAILED,
              `${config.assetLabel} expiry alert row failed`,
              {
                orgId,
                assetType: config.assetType,
                assetId: row.id,
                err: serializeLogError(error),
              }
            )
          }
        }
      }
    } catch (error) {
      if (logger) {
        operationalLog(
          logger,
          'error',
          OperationalEvent.MONITORING_EXPIRY_ALERT_ROW_FAILED,
          `${config.assetLabel} expiry alert row fetch failed for org`,
          { orgId, assetType: config.assetType, assetId: 'n/a', err: serializeLogError(error) }
        )
      }
    }
  }

  await sendNotificationJobs(boss, allJobs)
}
