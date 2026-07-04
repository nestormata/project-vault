import { and, eq, isNotNull } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import { certRecords } from '@project-vault/db/schema'
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

const JOB_NAME = 'cert:expiry-alert'
const TEMPLATE_ID = 'certificate.expiry'

type WorkerLogger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>
type CertRecordRow = typeof certRecords.$inferSelect

async function processRow(
  orgId: string,
  row: CertRecordRow,
  now: Date
): Promise<NotificationQueueJob[]> {
  if (!row.expiresAt) return []
  const daysRemaining = computeDaysRemaining(row.expiresAt, now)
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
            domain: row.domain,
            expiresAt: row.expiresAt?.toISOString() ?? null,
            daysRemaining,
            threshold: firing.threshold,
            overdue: firing.overdue,
          },
        },
      })
      jobs.push(...entries)
    }
    await tx
      .update(certRecords)
      .set({ notifiedLeadDays: nextNotifiedLeadDays })
      .where(eq(certRecords.id, row.id))
    return jobs
  })
}

export async function runCertExpiryAlertJob(
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
          .from(certRecords)
          .where(and(eq(certRecords.orgId, orgId), isNotNull(certRecords.expiresAt)))
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
              'certificate expiry alert row failed',
              { orgId, assetType: 'certificate', assetId: row.id, err: serializeLogError(error) }
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
          'certificate expiry alert row fetch failed for org',
          { orgId, assetType: 'certificate', assetId: 'n/a', err: serializeLogError(error) }
        )
      }
    }
  }

  await sendNotificationJobs(boss, allJobs)
}
