import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { users } from '@project-vault/db/schema'
import { renderEmailTemplate } from '../notifications/templates/index.js'
import { escapeHtml } from '../notifications/templates/html-safety.js'
import type { BossService } from '../lib/boss.js'
import type { FastifyBaseLogger } from 'fastify'
import nodemailer from 'nodemailer'
import { resolveSmtpTransportConfig } from '../modules/platform-admin/service.js'
import { getDeliveryProviderForChannel } from '../lib/delivery-provider.js'
import { applyDeliveryStatusUpdate } from '../notifications/delivery-status.js'
import {
  claimPendingNotificationEntry,
  markNotificationDelivered,
  markNotificationSuppressed,
} from './notification-queue-ops.js'
import {
  createNotificationJobHandler,
  runNotificationCatchup,
} from './notification-worker-common.js'

const EMAIL_CHANNEL = 'email'

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

/**
 * Story 20.11 AC1/AC8 — sends via the registered `DeliveryProvider` for the `email` channel
 * instead of the built-in SMTP transport. Only the same class of already-permitted
 * notification-template metadata `NotificationChannel` already carries crosses this boundary
 * (AC7) — never a decrypted credential, a raw share token, or a DB handle. Throwing here (a
 * rejected `send()`, or the provider hanging past the caller's own job-level timeout) propagates
 * unchanged to the pg-boss job handler, so the existing retry/backoff behavior applies identically
 * to a provider-backed send as to the SMTP path (AC1 edge case) — this function does not itself
 * add a bounding timeout beyond what pg-boss's job execution already imposes.
 */
async function sendViaDeliveryProvider(
  notificationQueueId: string,
  orgId: string,
  toAddress: string,
  templateId: string,
  subject: string,
  body: string
): Promise<void> {
  const provider = getDeliveryProviderForChannel(EMAIL_CHANNEL)
  if (!provider) throw new Error('sendViaDeliveryProvider called with no registered provider')

  const { providerMessageId } = await provider.send({
    recipientAddress: toAddress,
    subject,
    body,
    templateId,
    queueRowId: notificationQueueId,
  })

  // AC2/AC4: even the initial send-time transition goes through the single rank-based guard —
  // pending (rank 0) -> sent (rank 1) is always forward progress, so this always applies.
  await applyDeliveryStatusUpdate({
    notificationQueueId,
    orgId,
    newStatus: 'sent',
    providerId: EMAIL_CHANNEL,
    providerMessageId,
  })
}

/** Story 36.1 Design Decision 2/AC2 — builds outbound email content directly from an
 * extension-originated row's `payload.subject`/`payload.body`, bypassing the closed template
 * registry entirely. `payload` is opaque, caller-authored `jsonb` — coerced to `string` via
 * `String()` (never trusted to already be a string) before escaping, so a malformed row can't
 * throw here. */
function buildExtensionOriginatedEmailContent(payload: Record<string, unknown>): {
  subject: string
  text: string
  html: string
} {
  const subject = typeof payload['subject'] === 'string' ? payload['subject'] : ''
  const body = typeof payload['body'] === 'string' ? payload['body'] : ''
  return {
    subject,
    text: body,
    html: `<p>${escapeHtml(body)}</p>`,
  }
}

type QueueEntry = Awaited<ReturnType<typeof claimPendingNotificationEntry>>

/** Extracted from `sendEmailNotification` purely to keep its own cyclomatic complexity under
 * this repo's lint budget — the Story 36.1 originExtensionName rendering-branch decision. */
function renderOutboundEmailContent(
  entry: NonNullable<QueueEntry>,
  logger?: Pick<FastifyBaseLogger, 'error'>
): { subject: string; text: string | undefined; html: string | undefined } {
  return entry.originExtensionName
    ? buildExtensionOriginatedEmailContent(entry.payload as Record<string, unknown>)
    : renderEmailTemplate(entry.templateId, entry.payload as Record<string, unknown>, logger)
}

/** Extracted from `sendEmailNotification` purely to keep its own cyclomatic complexity under
 * this repo's lint budget. Resolves the outbound address from either the linked user's own email
 * (looked up fresh, never trusting a stale denormalized copy) or the entry's own recorded
 * recipientEmail. */
async function resolveToAddress(
  entry: NonNullable<QueueEntry>,
  orgId: string
): Promise<string | null> {
  if (entry.recipientUserId) {
    const recipientUserId = entry.recipientUserId
    const [user] = await withOrg(orgId, (tx) =>
      tx.select({ email: users.email }).from(users).where(eq(users.id, recipientUserId)).limit(1)
    )
    return user?.email ?? null
  }
  return entry.recipientEmail ?? null
}

/** Extracted from `sendEmailNotification` for the same complexity-budget reason as
 * `resolveToAddress` above: the built-in SMTP send path, unchanged from Story 3.1. */
async function sendViaSmtp(
  notificationQueueId: string,
  orgId: string,
  toAddress: string,
  subject: string,
  text: string | undefined,
  html: string | undefined,
  transport: NonNullable<Awaited<ReturnType<typeof getEmailTransport>>>
): Promise<void> {
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

export async function sendEmailNotification(
  notificationQueueId: string,
  orgId: string,
  logger?: Pick<FastifyBaseLogger, 'error'>
): Promise<void> {
  const provider = getDeliveryProviderForChannel(EMAIL_CHANNEL)
  const transport = provider ? null : await getEmailTransport()
  const entry = await claimPendingNotificationEntry(notificationQueueId, orgId)
  if (!entry) return

  if (!provider && !transport) {
    await markNotificationSuppressed(notificationQueueId, orgId)
    return
  }

  const toAddress = await resolveToAddress(entry, orgId)
  if (!toAddress) {
    await markNotificationSuppressed(notificationQueueId, orgId)
    return
  }

  // Story 36.1 Design Decision 2/Task 4 — an extension-originated row (originExtensionName
  // non-null) is built directly from its own caller-supplied subject/body, never through
  // renderEmailTemplate()'s closed EMAIL_RENDERERS registry (which would otherwise degrade to
  // genericEmailFallback's raw JSON.stringify(payload) dump for the reserved `ext.<name>`
  // templateId). HTML-escaped only in the HTML part — the plain-text part carries the raw
  // string unescaped, matching every existing template's own text/html split.
  const { subject, text, html } = renderOutboundEmailContent(entry, logger)

  if (provider) {
    await sendViaDeliveryProvider(
      notificationQueueId,
      orgId,
      toAddress,
      entry.templateId,
      subject,
      text ?? html ?? ''
    )
    return
  }

  // transport is non-null here: provider is falsy (checked above) and the !provider && !transport
  // suppression branch already returned when transport was null.
  if (!transport) return
  await sendViaSmtp(notificationQueueId, orgId, toAddress, subject, text, html, transport)
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
