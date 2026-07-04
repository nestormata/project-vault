import { and, eq, isNotNull } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import { domainRecords } from '@project-vault/db/schema'
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

const JOB_NAME = 'domain:expiry-alert'
const TEMPLATE_ID = 'domain.expiry'

type WorkerLogger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>
type DomainRecordRow = typeof domainRecords.$inferSelect

async function processRow(
  orgId: string,
  row: DomainRecordRow,
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
            domainName: row.domainName,
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
      .update(domainRecords)
      .set({ notifiedLeadDays: nextNotifiedLeadDays })
      .where(eq(domainRecords.id, row.id))
    return jobs
  })
}

export async function runDomainExpiryAlertJob(
  boss: BossService,
  logger?: WorkerLogger
): Promise<void> {
  const now = new Date()
  const orgIds = await fetchAllOrgIds()
  const allJobs: NotificationQueueJob[] = []

  for (const orgId of orgIds) {
    const rows = await runOrgScopedJob(orgId, JOB_NAME, ({ tx }) =>
      tx
        .select()
        .from(domainRecords)
        .where(and(eq(domainRecords.orgId, orgId), isNotNull(domainRecords.renewalDate)))
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
            'domain expiry alert row failed',
            { orgId, assetType: 'domain_record', assetId: row.id, err: serializeLogError(error) }
          )
        }
      }
    }
  }

  await sendNotificationJobs(boss, allJobs)
}
