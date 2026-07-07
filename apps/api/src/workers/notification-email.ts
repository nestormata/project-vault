import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { users } from '@project-vault/db/schema'
import { renderEmailTemplate } from '../notifications/templates/index.js'
import type { BossService } from '../lib/boss.js'
import type { FastifyBaseLogger } from 'fastify'
import nodemailer from 'nodemailer'
import { resolveSmtpTransportConfig } from '../modules/platform-admin/service.js'
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

/**
 * Story 9.2 D3/D4: consults the effective settings (system_settings DB override, falling back to
 * env vars — resolveSmtpTransportConfig()'s single precedence implementation) rather than reading
 * env vars directly, so a platform operator's `PUT /admin/settings` SMTP change actually takes
 * effect. `invalidateEmailTransport()` (below) must be called after any SMTP-field update, or the
 * new settings would silently never take effect until process restart (D4's documented bug).
 */
export async function getEmailTransport(): Promise<ReturnType<
  typeof nodemailer.createTransport
> | null> {
  if (_transport === null) return null
  if (_transport) return _transport
  const config = await resolveSmtpTransportConfig()
  if (!config) return null
  _transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user ? { user: config.user, pass: config.password ?? undefined } : undefined,
  })
  return _transport
}

export function setEmailTransportForTesting(
  transport: ReturnType<typeof nodemailer.createTransport> | null
): void {
  _transport = transport
}

/** Story 9.2 D4: production-safe cache invalidation — call after any `PUT /admin/settings`
 * request that changes an `smtp*` field, so the next email send rebuilds the transport against
 * the new configuration instead of reusing a stale cached one indefinitely. */
export function invalidateEmailTransport(): void {
  _transport = undefined
}

export function resetEmailTransportForTesting(): void {
  _transport = undefined
}

export async function sendEmailNotification(
  notificationQueueId: string,
  orgId: string
): Promise<void> {
  const transport = await getEmailTransport()
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

  // D3 precedence: the "from" address honors a system_settings override the same way host/port
  // do — resolveSmtpTransportConfig() is the single source of truth, so a second, independent
  // lookup isn't cached alongside the transport itself (kept simple: one extra DB read per send).
  const smtpConfig = await resolveSmtpTransportConfig()

  await transport.sendMail({
    from: smtpConfig?.from ?? undefined,
    to: toAddress,
    subject,
    text,
    html,
  })

  await markNotificationDelivered(notificationQueueId, orgId)
}

export const notificationEmailHandler = createNotificationJobHandler(
  'notification/email',
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
      jobName: 'notification/email',
      logMessage: 'Notification catchup found stale pending email entries',
    },
    logger
  )
}
