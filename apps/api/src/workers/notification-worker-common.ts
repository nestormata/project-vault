import { sql } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { withJobLogging } from '../lib/job-logging.js'
import type { BossService, BossJob } from '../lib/boss.js'
import type { FastifyBaseLogger } from 'fastify'

export function createNotificationJobHandler(
  jobName: string,
  sendFn: (notificationQueueId: string, orgId: string) => Promise<void>
) {
  return async function notificationJobHandler(
    job: BossJob,
    logger: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>
  ): Promise<void> {
    const notificationQueueId = job.data?.notificationQueueId
    const orgId = job.data?.orgId
    if (typeof notificationQueueId !== 'string' || typeof orgId !== 'string') {
      throw new TypeError(`${jobName} job missing notificationQueueId or orgId`)
    }
    await withJobLogging(logger, jobName, job.id ?? 'unknown', () =>
      sendFn(notificationQueueId, orgId)
    )
  }
}

export async function runNotificationCatchup(
  boss: BossService,
  options: {
    jobName: string
    channel?: 'email' | 'slack' | 'inbox'
    deliverAtAware?: boolean
    logMessage: string
  },
  logger: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>
): Promise<void> {
  const { fetchAllOrgIds } = await import('../middleware/rls.js')
  const orgIds = await fetchAllOrgIds()
  let total = 0
  const { jobName, channel, deliverAtAware = false, logMessage } = options

  for (const orgId of orgIds) {
    const staleEntries = await withOrg(orgId, (tx) =>
      tx.execute<{ id: string }>(
        deliverAtAware
          ? sql`
              SELECT id::text AS id
              FROM notification_queue
              WHERE org_id = ${orgId}::uuid
                AND status = 'pending'
                AND (deliver_at IS NULL OR deliver_at <= NOW())
                AND created_at < NOW() - INTERVAL '5 minutes'
              LIMIT 100
            `
          : sql`
              SELECT id::text AS id
              FROM notification_queue
              WHERE org_id = ${orgId}::uuid
                AND channel = ${channel}
                AND status = 'pending'
                AND created_at < NOW() - INTERVAL '5 minutes'
              LIMIT 100
            `
      )
    )
    for (const entry of staleEntries) {
      await boss.send(
        jobName,
        { notificationQueueId: entry.id, orgId },
        {
          retryLimit: 3,
          retryBackoff: true,
          retryDelay: 60,
        }
      )
      total++
    }
  }

  if (total > 0) {
    logger.warn({ eventType: 'notification.catchup.entries_found', count: total }, logMessage)
  }
}
