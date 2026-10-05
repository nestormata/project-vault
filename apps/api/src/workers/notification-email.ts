import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { users } from '@project-vault/db/schema'
import { DeliveryProviderPermanentError } from '@project-vault/extension-api'
import { renderEmailTemplate } from '../notifications/templates/index.js'
import { escapeHtml } from '../notifications/templates/html-safety.js'
import type { FastifyBaseLogger } from 'fastify'
import nodemailer from 'nodemailer'
import { resolveSmtpTransportConfig } from '../modules/platform-admin/service.js'
import { getDeliveryProviderForChannel } from '../lib/delivery-provider.js'
import { applyDeliveryStatusUpdate } from '../notifications/delivery-status.js'
import { OperationalEvent } from '@project-vault/shared'
import { operationalLog } from '../lib/logger.js'
import {
  markNotificationDelivered,
  markNotificationFailed,
  markNotificationSuppressed,
  type NotificationQueueRow,
} from './notification-queue-ops.js'
import { withClaimedNotification, type NotificationClaimContext } from './notification-claim.js'
import { createNotificationJobHandler } from './notification-worker-common.js'
import { notificationDeliveryPermanentFailureTotal } from './notification-metrics.js'

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
 * (AC7) — never a decrypted credential, a raw share token, or a DB handle. A rejected `send()`
 * propagates unchanged to the pg-boss job handler (after withClaimedNotification releases the
 * claim), so the existing retry/backoff behavior applies identically to a provider-backed send as
 * to the SMTP path. Story 70.1 AC4: `queueRowId` is the documented provider idempotency key and
 * `attemptNumber` the post-claim attempt count; the send runs through `claim.externalSend` so a
 * resolved send is never repeated even if the `sent` commit below fails (Decisions 2026-09-30).
 */
async function sendViaDeliveryProvider(
  entry: NotificationQueueRow,
  orgId: string,
  claim: NotificationClaimContext,
  message: DeliveryProviderMessage,
  logger?: EmailLogger
): Promise<void> {
  const provider = getDeliveryProviderForChannel(EMAIL_CHANNEL)
  if (!provider) throw new Error('sendViaDeliveryProvider called with no registered provider')

  let providerMessageId: string
  try {
    ;({ providerMessageId } = await claim.externalSend(() =>
      provider.send({
        recipientAddress: message.toAddress,
        subject: message.subject,
        body: message.body,
        ...(message.html === undefined ? {} : { html: message.html }),
        templateId: entry.templateId,
        queueRowId: entry.id,
        attemptNumber: entry.attemptCount,
      })
    ))
  } catch (error) {
    if (!isDeliveryProviderPermanentError(error)) throw error
    await recordPermanentDeliveryFailure(entry, orgId, error, logger)
    return
  }

  // AC2/AC4: even the initial send-time transition goes through the single rank-based guard —
  // pending (rank 0) -> sent (rank 1) is always forward progress, so this always applies.
  await applyDeliveryStatusUpdate({
    notificationQueueId: entry.id,
    orgId,
    newStatus: 'sent',
    providerId: EMAIL_CHANNEL,
    providerMessageId,
  })
}

type DeliveryProviderMessage = { toAddress: string; subject: string; body: string; html?: string }

/**
 * Story 70.3 AC1 — the payload message for a provider. `body` keeps its pre-70.3 value
 * (`text ?? html ?? ''`) so a provider that reads only `body` is unchanged; `html` is added only
 * when the rendered content has an HTML part (the key is absent otherwise).
 */
export function buildDeliveryProviderMessage(
  toAddress: string,
  content: { subject: string; text: string | undefined; html: string | undefined }
): DeliveryProviderMessage {
  const message: DeliveryProviderMessage = {
    toAddress,
    subject: content.subject,
    body: content.text ?? content.html ?? '',
  }
  if (content.html !== undefined) message.html = content.html
  return message
}

const PERMANENT_ERROR_NAME = 'DeliveryProviderPermanentError'

/**
 * Story 70.3 AC3 — true for the contract's permanent-failure error, by class identity OR by
 * `name`, so an extension that bundles its own copy of `@project-vault/extension-api` (where
 * `instanceof` is false) is still classified correctly.
 */
function isDeliveryProviderPermanentError(error: unknown): error is { reason?: unknown } {
  if (error instanceof DeliveryProviderPermanentError) return true
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === PERMANENT_ERROR_NAME
  )
}

const REASON_SLUG_PATTERN = /^[a-z][a-z0-9_]{0,63}$/

/** The error's `reason` only when it is a valid slug: a duplicate class carries no constructor
 * validation, so it is re-checked here and never logged otherwise. */
function permanentFailureReason(error: { reason?: unknown }): string | undefined {
  const { reason } = error
  return typeof reason === 'string' && REASON_SLUG_PATTERN.test(reason) ? reason : undefined
}

/**
 * Story 70.3 AC3/AC4 — a permanent provider rejection ends the row as `failed` with no retry:
 * recorded through the single rank-guarded `markNotificationFailed`, counted and logged once per
 * row THIS call moved to `failed`, then the handler resolves. If marking throws, the error
 * propagates and `withClaimedNotification` releases the claim, so the retry calls the provider
 * again (it rejected the previous call, so this is never a double send). The error's `message` and
 * `cause` are never logged or stored: only the validated `reason` slug.
 */
async function recordPermanentDeliveryFailure(
  entry: NotificationQueueRow,
  orgId: string,
  error: { reason?: unknown },
  logger?: EmailLogger
): Promise<void> {
  if (!(await markNotificationFailed(entry.id, orgId))) return
  notificationDeliveryPermanentFailureTotal.inc({ channel: EMAIL_CHANNEL })
  if (!logger) return
  const reason = permanentFailureReason(error)
  operationalLog(
    logger,
    'error',
    OperationalEvent.NOTIFICATION_DELIVERY_PERMANENT_FAILURE,
    'Delivery provider reported a permanent failure; notification marked failed, not retried',
    {
      notificationQueueId: entry.id,
      orgId,
      channel: EMAIL_CHANNEL,
      attemptNumber: entry.attemptCount,
      ...(reason === undefined ? {} : { reason }),
    }
  )
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

/** Extracted from `sendEmailNotification` purely to keep its own cyclomatic complexity under
 * this repo's lint budget — the Story 36.1 originExtensionName rendering-branch decision. */
function renderOutboundEmailContent(
  entry: NotificationQueueRow,
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
  entry: NotificationQueueRow,
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

/** Story 70.1 Decisions 2026-09-30 — the fallback Message-ID domain when no usable SMTP
 * from-address is configured (`.invalid` is reserved by RFC 2606, so it can never collide). */
export const NOTIFICATION_MESSAGE_ID_FALLBACK_DOMAIN = 'project-vault.invalid'

const MESSAGE_ID_DOMAIN_MAX_LENGTH = 253
const MESSAGE_ID_LABEL_CHARSET = /^[a-z0-9-]{1,63}$/i

/** A conservative hostname check for the Message-ID right-hand side: total length, and every
 * dot-separated label non-empty, LDH-only and not starting/ending with `-` (so no `..`, no
 * leading/trailing `.`). Anything else falls back. */
function isUsableMessageIdDomain(domain: string): boolean {
  if (domain.length === 0 || domain.length > MESSAGE_ID_DOMAIN_MAX_LENGTH) return false
  return domain
    .split('.')
    .every(
      (label) =>
        MESSAGE_ID_LABEL_CHARSET.test(label) && !label.startsWith('-') && !label.endsWith('-')
    )
}

/**
 * Story 70.1 Decisions 2026-09-30 — the deterministic SMTP `Message-ID` for a queue row:
 * `<pv-nq-<queueRowId>@<domain>>`. The same row always yields the same id, so a receiving system
 * (or an operator) can correlate a message to its row. `<domain>` is the part after the last `@`
 * of the effective SMTP from-address (a display name and angle brackets are tolerated); anything
 * unusable falls back to NOTIFICATION_MESSAGE_ID_FALLBACK_DOMAIN.
 */
export function buildNotificationMessageId(
  queueRowId: string,
  from: string | null | undefined
): string {
  const candidate = (from ?? '').trim().replace(/>$/, '')
  const at = candidate.lastIndexOf('@')
  const domain = at === -1 ? '' : candidate.slice(at + 1).trim()
  const safeDomain = isUsableMessageIdDomain(domain)
    ? domain.toLowerCase()
    : NOTIFICATION_MESSAGE_ID_FALLBACK_DOMAIN
  return `<pv-nq-${queueRowId}@${safeDomain}>`
}

/** Extracted from `sendEmailNotification` for the same complexity-budget reason as
 * `resolveToAddress` above: the built-in SMTP send path (Story 3.1), plus Story 70.1's
 * deterministic Message-ID and at-most-once `claim.externalSend`. */
async function sendViaSmtp(
  entry: NotificationQueueRow,
  orgId: string,
  claim: NotificationClaimContext,
  message: {
    toAddress: string
    subject: string
    text: string | undefined
    html: string | undefined
  },
  transport: NonNullable<Awaited<ReturnType<typeof getEmailTransport>>>
): Promise<void> {
  // D3 precedence: the "from" address honors a system_settings override the same way host/port
  // do — resolveSmtpTransportConfig() is the single source of truth, so a second, independent
  // lookup isn't cached alongside the transport itself (kept simple: one extra DB read per send).
  const smtpConfig = await resolveSmtpTransportConfig()
  const from = smtpConfig?.from ?? undefined

  await claim.externalSend(() =>
    transport.sendMail({
      from,
      messageId: buildNotificationMessageId(entry.id, from),
      to: message.toAddress,
      subject: message.subject,
      text: message.text,
      html: message.html,
    })
  )

  await markNotificationDelivered(entry.id, orgId)
}

type EmailLogger = Pick<FastifyBaseLogger, 'error'> & Partial<Pick<FastifyBaseLogger, 'warn'>>

/** Story 70.1 — the body of one claimed email attempt (suppression, address, render, send). */
async function deliverClaimedEmail(
  entry: NotificationQueueRow,
  orgId: string,
  claim: NotificationClaimContext,
  route: { hasProvider: boolean; transport: Awaited<ReturnType<typeof getEmailTransport>> },
  logger?: EmailLogger
): Promise<void> {
  if (!route.hasProvider && !route.transport) {
    await markNotificationSuppressed(entry.id, orgId)
    return
  }

  const toAddress = await resolveToAddress(entry, orgId)
  if (!toAddress) {
    await markNotificationSuppressed(entry.id, orgId)
    return
  }

  // Story 36.1 Design Decision 2/Task 4 — an extension-originated row (originExtensionName
  // non-null) is built directly from its own caller-supplied subject/body, never through
  // renderEmailTemplate()'s closed EMAIL_RENDERERS registry (which would otherwise degrade to
  // genericEmailFallback's raw JSON.stringify(payload) dump for the reserved `ext.<name>`
  // templateId). HTML-escaped only in the HTML part — the plain-text part carries the raw
  // string unescaped, matching every existing template's own text/html split.
  const { subject, text, html } = renderOutboundEmailContent(entry, logger)

  if (route.hasProvider) {
    await sendViaDeliveryProvider(
      entry,
      orgId,
      claim,
      buildDeliveryProviderMessage(toAddress, { subject, text, html }),
      logger
    )
    return
  }

  // transport is non-null here: hasProvider is false and the suppression branch above already
  // returned when transport was null.
  if (!route.transport) return
  await sendViaSmtp(entry, orgId, claim, { toAddress, subject, text, html }, route.transport)
}

/**
 * Story 70.1 AC1/AC2 — the email send goes through withClaimedNotification: exactly one caller
 * claims the row, a failure before the send resolved releases it for the pg-boss retry, and a
 * resolved send is never repeated (Decisions 2026-09-30).
 */
export async function sendEmailNotification(
  notificationQueueId: string,
  orgId: string,
  logger?: EmailLogger
): Promise<void> {
  const hasProvider = getDeliveryProviderForChannel(EMAIL_CHANNEL) !== undefined
  const transport = hasProvider ? null : await getEmailTransport()
  await withClaimedNotification(
    notificationQueueId,
    orgId,
    (entry, claim) => deliverClaimedEmail(entry, orgId, claim, { hasProvider, transport }, logger),
    logger
  )
}

export const notificationEmailHandler = createNotificationJobHandler(
  'notification/email',
  sendEmailNotification
)
