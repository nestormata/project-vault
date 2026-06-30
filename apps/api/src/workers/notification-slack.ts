import { env } from '../config/env.js'
import { renderSlackTemplate } from '../notifications/templates/index.js'
import type { BossService } from '../lib/boss.js'
import type { FastifyBaseLogger } from 'fastify'
import {
  claimPendingNotificationEntry,
  markNotificationDelivered,
  markNotificationSuppressed,
} from './notification-queue-ops.js'
import {
  createNotificationJobHandler,
  runNotificationCatchup,
} from './notification-worker-common.js'

export async function sendSlackNotification(
  notificationQueueId: string,
  orgId: string
): Promise<void> {
  const webhookUrl = env.SLACK_WEBHOOK_URL
  if (!webhookUrl) {
    await markNotificationSuppressed(notificationQueueId, orgId)
    return
  }

  const entry = await claimPendingNotificationEntry(notificationQueueId, orgId)
  if (!entry) return

  const { text, blocks } = renderSlackTemplate(
    entry.templateId,
    entry.payload as Record<string, unknown>
  )

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, blocks }),
  })

  if (!response.ok) {
    throw new Error(`Slack webhook returned ${response.status}`)
  }

  await markNotificationDelivered(notificationQueueId, orgId)
}

export const notificationSlackHandler = createNotificationJobHandler(
  'notification:slack',
  sendSlackNotification
)

export async function notificationSlackCatchupHandler(
  boss: BossService,
  logger: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>
): Promise<void> {
  await runNotificationCatchup(
    boss,
    'slack',
    'notification:slack',
    logger,
    'Notification catchup found stale pending slack entries'
  )
}
