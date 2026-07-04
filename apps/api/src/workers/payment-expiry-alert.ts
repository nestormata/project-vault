import { and, eq, isNotNull } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import { paymentRecords } from '@project-vault/db/schema'
import { OperationalEvent } from '@project-vault/shared'
import type { BossService } from '../lib/boss.js'
import { fetchAllOrgIds, runOrgScopedJob } from '../middleware/rls.js'
import {
  createOrgAdminNotificationEntries,
  sendNotificationJobs,
  type NotificationQueueJob,
} from '../notifications/dispatcher.js'
import { operationalLog, serializeLogError } from '../lib/logger.js'
import { computeDaysRemaining, computeExpiryAlertFirings } from './expiry-alert-shared.js'

const JOB_NAME = 'payment:expiry-alert'
const TEMPLATE_ID = 'payment.expiry'

type WorkerLogger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>
type PaymentRecordRow = typeof paymentRecords.$inferSelect

/**
 * Matches, dispatches, and persists notifiedLeadDays for a single row inside its own
 * org-scoped transaction (AC 5 failure isolation: one row's failure must not abort the batch,
 * and the notification-queue insert + notifiedLeadDays update must commit together).
 */
async function processRow(
  orgId: string,
  row: PaymentRecordRow,
  now: Date
): Promise<NotificationQueueJob[]> {
  if (!row.renewalDate) return []
  const daysRemaining = computeDaysRemaining(row.renewalDate, now)
  const { firings, nextNotifiedLeadDays } = computeExpiryAlertFirings({
    daysRemaining,
    alertLeadDays: row.alertLeadDays,
    notifiedLeadDays: row.notifiedLeadDays,
  })
  if (firings.length === 0) return []

  return runOrgScopedJob(orgId, JOB_NAME, async ({ tx }) => {
    const jobs: NotificationQueueJob[] = []
    for (const firing of firings) {
      const entries = await createOrgAdminNotificationEntries({
        orgId,
        tx,
        template: {
          templateId: TEMPLATE_ID,
          severity: firing.severity,
          payload: {
            assetId: row.id,
            projectId: row.projectId,
            name: row.name,
            renewalDate: row.renewalDate?.toISOString() ?? null,
            daysRemaining,
            threshold: firing.threshold,
            overdue: firing.overdue,
          },
        },
      })
      jobs.push(...entries)
    }
    await tx
      .update(paymentRecords)
      .set({ notifiedLeadDays: nextNotifiedLeadDays })
      .where(eq(paymentRecords.id, row.id))
    return jobs
  })
}

export async function runPaymentExpiryAlertJob(
  boss: BossService,
  logger?: WorkerLogger
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
      const rows = await runOrgScopedJob(orgId, JOB_NAME, ({ tx }) =>
        tx
          .select()
          .from(paymentRecords)
          .where(and(eq(paymentRecords.orgId, orgId), isNotNull(paymentRecords.renewalDate)))
      )

      for (const row of rows) {
        try {
          const jobs = await processRow(orgId, row, now)
          allJobs.push(...jobs)
        } catch (error) {
          if (logger) {
            operationalLog(
              logger,
              'error',
              OperationalEvent.MONITORING_EXPIRY_ALERT_ROW_FAILED,
              'payment expiry alert row failed',
              { orgId, assetType: 'payment_record', assetId: row.id, err: serializeLogError(error) }
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
          'payment expiry alert row fetch failed for org',
          { orgId, assetType: 'payment_record', assetId: 'n/a', err: serializeLogError(error) }
        )
      }
    }
  }

  await sendNotificationJobs(boss, allJobs)
}
