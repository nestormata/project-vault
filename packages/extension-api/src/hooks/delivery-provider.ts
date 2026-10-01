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
   * provider should deduplicate on it. */
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
}
