/**
 * AC2/AC3 — `NotificationChannel` is one of the three typed hook interfaces this package
 * exports. Serializable-data-only payload per architecture.md § Data Boundaries.
 */
export type NotificationPayload = {
  subject: string
  body: string
}

export type NotificationChannel = {
  /** Delivers a notification through the extension's channel (e.g. Slack, email, webhook). */
  onNotify(payload: NotificationPayload): Promise<void>
}
