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
  queueRowId: string
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
   * `sendMail()` failure — the existing dispatcher retry/backoff applies unchanged (AC1). */
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
