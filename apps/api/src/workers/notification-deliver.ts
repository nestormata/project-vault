import type { EventEmitter } from 'node:events'
import { sendEmailNotification } from './notification-email.js'
import { sendSlackNotification } from './notification-slack.js'
import { deliverInboxNotification } from './notification-inbox.js'
import { withOrg } from '@project-vault/db'
import { notificationQueue } from '@project-vault/db/schema'
import { eq } from 'drizzle-orm'
import { createNotificationJobHandler } from './notification-worker-common.js'
import type { FastifyBaseLogger } from 'fastify'
import type { BossJob } from '../lib/boss.js'

export async function deliverNotification(
  notificationQueueId: string,
  orgId: string,
  emitter?: EventEmitter
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
      if (!emitter) {
        throw new Error('notification/deliver inbox channel requires EventEmitter')
      }
      await deliverInboxNotification(notificationQueueId, orgId, emitter)
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

export function createDeliverNotificationHandler(emitter: EventEmitter) {
  return createNotificationJobHandler('notification/deliver', (notificationQueueId, orgId) =>
    deliverNotification(notificationQueueId, orgId, emitter)
  )
}

export const notificationDeliverHandler = createNotificationJobHandler(
  'notification/deliver',
  (notificationQueueId, orgId) => deliverNotification(notificationQueueId, orgId)
)

export function wrapDeliverHandler(
  logger: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>,
  emitter?: EventEmitter
): (job: BossJob) => Promise<void> {
  const handler = emitter ? createDeliverNotificationHandler(emitter) : notificationDeliverHandler
  return (job) => handler(job, logger)
}
