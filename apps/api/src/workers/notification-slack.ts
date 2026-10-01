import { env } from '../config/env.js'
import { renderSlackTemplate } from '../notifications/templates/index.js'
import type { FastifyBaseLogger } from 'fastify'
import { markNotificationDelivered, markNotificationSuppressed } from './notification-queue-ops.js'
import { withClaimedNotification } from './notification-claim.js'
import { createNotificationJobHandler } from './notification-worker-common.js'

/**
 * Story 70.1 AC1/AC2 — the Slack POST goes through withClaimedNotification: one caller claims the
 * row; a non-2xx response or a fetch error is a definite failure (released, retried by pg-boss);
 * a 2xx response is never re-posted even if the `delivered` commit fails (Decisions 2026-09-30).
 * Suppression when no webhook is configured stays BEFORE the claim, as before.
 */
export async function sendSlackNotification(
  notificationQueueId: string,
  orgId: string,
  logger?: Pick<FastifyBaseLogger, 'error'> & Partial<Pick<FastifyBaseLogger, 'warn'>>
): Promise<void> {
  const webhookUrl = env.SLACK_WEBHOOK_URL
  if (!webhookUrl) {
    await markNotificationSuppressed(notificationQueueId, orgId)
    return
  }

  await withClaimedNotification(
    notificationQueueId,
    orgId,
    async (entry, claim) => {
      const { text, blocks } = renderSlackTemplate(
        entry.templateId,
        entry.payload as Record<string, unknown>,
        logger
      )

      await claim.externalSend(async () => {
        const response = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, blocks }),
        })
        if (!response.ok) {
          throw new Error(`Slack webhook returned ${response.status}`)
        }
      })

      await markNotificationDelivered(notificationQueueId, orgId)
    },
    logger
  )
}

export const notificationSlackHandler = createNotificationJobHandler(
  'notification/slack',
  sendSlackNotification
)
