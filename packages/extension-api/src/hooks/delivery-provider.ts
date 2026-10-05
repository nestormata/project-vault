/**
 * Story 20.11 AC1/AC7 — the `DeliveryProvider` hook category, additive to the existing
 * `NotificationChannel`/`UIPanel` set. A registered provider's `send()` is called by PV's own
 * dispatcher INSTEAD of the built-in nodemailer transport, only for the channel it is registered
 * against (see `ExtensionHooks.deliveryProvider`, keyed by channel name). Payload is limited to
 * the same class of already-permitted notification-template metadata `NotificationChannel`
 * already carries — never a decrypted credential value, a raw share token, or a live database
 * connection object (AC7).
 */
export type DeliveryProviderSendPayload = {
  recipientAddress: string
  subject: string
  body: string
  /**
   * Story 70.3 — the HTML rendering of the same message, when it has one. Optional and additive:
   * `body` keeps its exact earlier value (the text part, or the html part when the template has
   * no text part), so a provider that reads only `body` behaves as before. Every PV-native
   * template and every extension-originated notification renders an HTML part, so a provider that
   * takes over PV email should forward `html` (for example as Resend's `html` field next to
   * `text`) instead of sending plain text only. The key is absent, never `''`, when the message
   * has no HTML part. When there is no text part, `html` equals `body`.
   */
  html?: string
  templateId: string
  /**
   * The idempotency key for this notification. Stable for the life of the `notification_queue`
   * row across every retry, reclaim and process restart; unique per notification (a UUID that is
   * never reused). Forward it as the provider's own idempotency key, for example
   * `Idempotency-Key: pv-nq-<queueRowId>`.
   *
   * Delivery semantics: PV calls `send()` again for the same `queueRowId` only after an earlier
   * `send()` for it rejected. Once `send()` resolves, or while its outcome is unknown (the process
   * stopped during the call, or PV could not record the result), PV never calls `send()` for that
   * row again and marks the row `failed` instead: at most once for an ambiguous outcome. A
   * provider whose `send()` can reject after the message was actually accepted (for example on a
   * timeout) closes that last window by deduplicating on `queueRowId`.
   *
   * It is an opaque correlation value, not a capability: PV resolves delivery-status webhooks only
   * by `providerMessageId`, never by a `queueRowId` echoed back by the provider. Keep it out of
   * recipient-visible content; there is no reason to expose internal row ids to recipients.
   */
  queueRowId: string
  /**
   * 1-based number of this attempt: the row's attempt count after this attempt's claim. Strictly
   * increasing per row and never reset; never above 5 (PV's maximum attempts). It counts PV
   * claims, not provider calls: a claim that ended before `send()` (for example a failed address
   * lookup) still used a number, so a provider can see `attemptNumber: 2` on its first call. Gaps
   * are normal. For logging and metrics only: never make it part of the idempotency key (every
   * retry has a new number).
   */
  attemptNumber: number
}

const PERMANENT_ERROR_REASON_PATTERN = /^[a-z][a-z0-9_]*$/
const PERMANENT_ERROR_REASON_MAX_LENGTH = 64

/**
 * Story 70.3 — throw this from `DeliveryProvider.send()` when the provider knows retrying cannot
 * succeed (an invalid or suppressed recipient, a hard rejection). PV then records the
 * `notification_queue` row as `failed` and does NOT retry it. Throw it only for a definite,
 * permanent rejection: never for a timeout, a 5xx or a rate limit (throw an ordinary `Error` for
 * those and PV retries up to its maximum attempts).
 *
 * `reason` is an optional short slug (`^[a-z][a-z0-9_]*$`, at most 64 characters, for example
 * `invalid_recipient`) that PV logs and may use in diagnostics. The constructor throws a
 * `TypeError` for anything else, so a recipient address or free text cannot reach a log field.
 * PV never logs or stores `message` or `cause`. PV recognises the class by identity or by
 * `name === 'DeliveryProviderPermanentError'`, so an extension that bundles its own copy of this
 * package is still classified correctly.
 */
export class DeliveryProviderPermanentError extends Error {
  readonly reason: string | undefined

  constructor(message: string, options?: { reason?: string; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'DeliveryProviderPermanentError'
    const reason = options?.reason
    if (
      reason !== undefined &&
      (reason.length > PERMANENT_ERROR_REASON_MAX_LENGTH ||
        !PERMANENT_ERROR_REASON_PATTERN.test(reason))
    ) {
      throw new TypeError(
        `DeliveryProviderPermanentError reason must match ${PERMANENT_ERROR_REASON_PATTERN} and be at most ${PERMANENT_ERROR_REASON_MAX_LENGTH} characters`
      )
    }
    this.reason = reason
    Object.setPrototypeOf(this, DeliveryProviderPermanentError.prototype)
  }
}

export type DeliveryProviderSendResult = {
  /** Provider-assigned message identifier, recorded on the `notification_queue` row at send time
   * and used later to resolve an inbound delivery-status webhook event back to that row (AC3, AC9). */
  providerMessageId: string
}

/** AC2/AC4 — the delivery-status values a provider's webhook payload can report. Mirrors
 * `notification_queue.status`'s extended enum (minus `pending`, which is never reported by a
 * provider — it is PV's own pre-send state). */
export type DeliveryStatusValue = 'sent' | 'delivered' | 'bounced' | 'suppressed' | 'failed'

export type DeliveryStatusEvent = {
  providerMessageId: string
  status: DeliveryStatusValue
}

export type DeliveryProvider = {
  /** Sends one notification through the extension's own delivery mechanism. Throwing (or the
   * host's own bounded timeout elapsing) is treated identically to the built-in SMTP path's own
   * `sendMail()` failure — the existing dispatcher retry/backoff applies unchanged (AC1), with the
   * same `queueRowId` and a higher `attemptNumber`. A resolved call is never repeated for the same
   * row; see `DeliveryProviderSendPayload.queueRowId` for the full delivery semantics and why a
   * provider should deduplicate on it. Throw `DeliveryProviderPermanentError` (and only then) when
   * the rejection is permanent: the row is recorded as `failed` and never retried. */
  send(payload: DeliveryProviderSendPayload): Promise<DeliveryProviderSendResult>
  /**
   * AC3/AC6 — verifies an inbound webhook request's signature using a secret scoped to this
   * provider registration, never a shared/global secret. The host never applies a status update
   * (via `applyDeliveryStatusUpdate()`) unless this returns `true`. Never throws for an
   * ordinary invalid/malformed signature — returns `false` instead, so the route can respond with
   * a single, non-enumerating rejection shape (AC6).
   */
  verifyWebhookSignature(input: {
    rawBody: string
    headers: Record<string, string | string[] | undefined>
  }): boolean
  /**
   * AC3 — parses an already-signature-verified raw webhook body into zero-or-more delivery-status
   * events. Returns an empty array for a payload the provider recognizes as a non-event (e.g. a
   * ping/health-check callback) rather than throwing.
   */
  parseWebhookEvents(rawBody: string): DeliveryStatusEvent[]
  /**
   * Story 70.3 — optional per-provider rate limit for the unauthenticated inbound webhook route
   * (`POST /api/v1/notifications/delivery-webhook/:providerId`), per caller IP. Absent means the
   * default of 60 requests per 60 seconds. `max` is an integer from 1 to 10 000 and
   * `windowSeconds` an integer from 1 to 3600 (default 60). PV bounds the declaration: a value
   * outside these ranges fails extension registration loudly (it is never clamped), so a provider
   * cannot switch the limit off. Use it for a provider whose service legitimately sends bursts
   * (retries, bulk bounce waves).
   */
  webhookRateLimit?: { max: number; windowSeconds?: number }
}
