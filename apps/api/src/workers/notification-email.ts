import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { users } from '@project-vault/db/schema'
import { env } from '../config/env.js'
import { renderEmailTemplate } from '../notifications/templates/index.js'
import type { BossService } from '../lib/boss.js'
import type { FastifyBaseLogger } from 'fastify'
import nodemailer from 'nodemailer'
import {
  claimPendingNotificationEntry,
  markNotificationDelivered,
  markNotificationSuppressed,
} from './notification-queue-ops.js'
import {
  createNotificationJobHandler,
  runNotificationCatchup,
} from './notification-worker-common.js'

let _transport: ReturnType<typeof nodemailer.createTransport> | null | undefined

export function getEmailTransport(): ReturnType<typeof nodemailer.createTransport> | null {
  if (_transport === null) return null
  if (_transport) return _transport
  if (!env.SMTP_HOST) return null
  _transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT ?? 587,
    secure: env.SMTP_SECURE ?? false,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  })
  return _transport
}

export function setEmailTransportForTesting(
  transport: ReturnType<typeof nodemailer.createTransport> | null
): void {
  _transport = transport
}

export function resetEmailTransportForTesting(): void {
  _transport = undefined
}

export async function sendEmailNotification(
  notificationQueueId: string,
  orgId: string
): Promise<void> {
  const transport = getEmailTransport()
  const entry = await claimPendingNotificationEntry(notificationQueueId, orgId)
  if (!entry) return

  if (!transport) {
    await markNotificationSuppressed(notificationQueueId, orgId)
    return
  }

  let toAddress: string | null = null
  if (entry.recipientUserId) {
    const recipientUserId = entry.recipientUserId
    const [user] = await withOrg(orgId, (tx) =>
      tx.select({ email: users.email }).from(users).where(eq(users.id, recipientUserId)).limit(1)
    )
    toAddress = user?.email ?? null
  } else if (entry.recipientEmail) {
    toAddress = entry.recipientEmail
  }
  if (!toAddress) {
    await markNotificationSuppressed(notificationQueueId, orgId)
    return
  }

  const { subject, text, html } = renderEmailTemplate(
    entry.templateId,
    entry.payload as Record<string, unknown>
  )

  await transport.sendMail({
    from: env.SMTP_FROM,
    to: toAddress,
    subject,
    text,
    html,
  })

  await markNotificationDelivered(notificationQueueId, orgId)
}

export const notificationEmailHandler = createNotificationJobHandler(
  'notification:email',
  sendEmailNotification
)

export async function notificationEmailCatchupHandler(
  boss: BossService,
  logger: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>
): Promise<void> {
  await runNotificationCatchup(
    boss,
    {
      channel: 'email',
      jobName: 'notification:email',
      logMessage: 'Notification catchup found stale pending email entries',
    },
    logger
  )
}
