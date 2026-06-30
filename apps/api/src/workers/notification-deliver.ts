import { sendEmailNotification } from './notification-email.js'
import { sendSlackNotification } from './notification-slack.js'
import { withOrg } from '@project-vault/db'
import { notificationQueue } from '@project-vault/db/schema'
import { eq } from 'drizzle-orm'
import { createNotificationJobHandler } from './notification-worker-common.js'
import type { FastifyBaseLogger } from 'fastify'
import type { BossJob } from '../lib/boss.js'

export async function deliverNotification(
  notificationQueueId: string,
  orgId: string
): Promise<void> {
  const [entry] = await withOrg(orgId, (tx) =>
    tx
      .select({
        channel: notificationQueue.channel,
        deliverAt: notificationQueue.deliverAt,
        status: notificationQueue.status,
      })
      .from(notificationQueue)
      .where(eq(notificationQueue.id, notificationQueueId))
      .limit(1)
  )

  if (!entry || entry.status !== 'pending') return
  if (entry.deliverAt && entry.deliverAt.getTime() > Date.now()) return

  switch (entry.channel) {
    case 'email':
      await sendEmailNotification(notificationQueueId, orgId)
      break
    case 'slack':
      await sendSlackNotification(notificationQueueId, orgId)
      break
    case 'inbox':
      break
    default:
      process.stderr.write(
        `${JSON.stringify({
          eventType: 'notification.unknown_channel',
          channel: entry.channel,
          queueId: notificationQueueId,
        })}\n`
      )
  }
}

export const notificationDeliverHandler = createNotificationJobHandler(
  'notification:deliver',
  deliverNotification
)

export function wrapDeliverHandler(
  logger: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>
): (job: BossJob) => Promise<void> {
  return (job) => notificationDeliverHandler(job, logger)
}
