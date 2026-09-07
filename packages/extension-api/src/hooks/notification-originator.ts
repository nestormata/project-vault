/**
 * Story 36.1 — `NotificationOriginatorHost` is the fifth `HostServices` field (see
 * `host-services.ts`), same directionality as `AuditEventSourceHost`/`OrgAuthorizationHost`/
 * `EphemeralStateHost`/`PvMonitoringHost`: PV implements `enqueueNotification()` and hands a
 * bound instance to the extension via `HostServices`. It does NOT belong in `ExtensionHooks`
 * alongside `NotificationChannel`/`DeliveryProvider` — those are things the extension
 * *implements* for PV to call (PV-calls-out); this is PV *servicing* the extension
 * (extension-calls-in).
 *
 * **Naming collision, stated explicitly.** This field's name (`notificationOriginator`) and the
 * pre-existing `'notification-channel'` `ExtensionCapability`/`ExtensionHooks.notificationChannel`
 * both contain the word "notification" but are otherwise unrelated: `'notification-channel'`
 * gates `ExtensionHooks.notificationChannel` (an extension registering an outbound sink PV
 * calls), entirely orthogonal to this `HostServices` field. `host.notificationOriginator` is NOT
 * gated by `'notification-channel'` (or any other capability literal) — no existing
 * `HostServices` field has ever been gated behind a manifest-declared capability, and this field
 * follows that exact precedent.
 *
 * **Reuses `notification_queue`/`notification-deliver.ts` verbatim (Design Decision 2).** A
 * fresh row is inserted with `templateId: \`ext.${manifest.name}\`` (a reserved, host-computed
 * sentinel, never caller-supplied) and `payload: { subject, body }`; PV's existing
 * `notification-deliver.ts` dispatch/retry/delivery-provider logic applies completely unchanged.
 * `sendEmailNotification`/`deliverInboxNotification` each gain one new branch: when
 * `entry.originExtensionName` is non-null, the outbound content is built directly from
 * `entry.payload.subject`/`entry.payload.body` instead of going through the closed
 * `EMAIL_RENDERERS`/`SLACK_RENDERERS`/`genericEmailFallback` template registry (which would
 * otherwise degrade to a raw `JSON.stringify(payload)` dump for any unrecognized `templateId`).
 *
 * **Channel scope for v1 — `'email' | 'inbox'` only (Design Decision 3).** `'slack'` is
 * deliberately excluded: `notification_queue.channel`'s existing `'slack'` value delivers
 * through exactly one org-wide webhook with no per-recipient concept, a materially different
 * trust surface from emailing/inbox-messaging one already-verified org member.
 * `NotificationOriginatorChannel` is written as an open union of the two shipped values
 * specifically so adding `'slack'` later stays additive.
 *
 * **Authorization/tenant-scoping — ambient per-request org (Design Decision 4).**
 * `enqueueNotification()` is always called in-request — there is no background-worker call site
 * for this hook. `NotificationOriginatorEnqueueParams` has structurally NO `organizationId`
 * field: the host resolves it ambiently via `apps/api/src/lib/request-context.ts`'s
 * `getRequestContext()` at call time, mirroring `OrgAuthorizationHost`'s post-Story-23.11 shape.
 * `recipientUserId`, when supplied, is validated as resolving to an actual member of the ambient
 * org BEFORE the insert — a caller error here is loud and immediate, never a silently-swallowed
 * `suppressed` queue row discovered only later.
 */

/** Design Decision 3 — open union so a future `'slack'` value stays additive. */
export type NotificationOriginatorChannel = 'email' | 'inbox'

/**
 * Design Decision 4 — deliberately has no `organizationId`/`orgId` field. The host resolves the
 * ambient org itself; there is structurally no way for a caller to name a different org.
 *
 * Exactly one of `recipientUserId`/`recipientEmail` must be supplied. `recipientEmail` is only
 * legal for `channel: 'email'` — `channel: 'inbox'` structurally requires a real user row
 * (mirrors `deliverInboxNotification`'s own hard `recipientUserId` requirement).
 */
export type NotificationOriginatorEnqueueParams = {
  channel: NotificationOriginatorChannel
  recipientUserId?: string
  /** `channel: 'email'` only. Accepted as freeform, unvalidated-against-org-membership text,
   * exactly as PV's own existing `notification_queue.recipientEmail` column already is for
   * non-user-linked email sends (e.g. an invited-but-not-yet-registered address) — this is not a
   * new trust boundary, only a new caller of an existing one. */
  recipientEmail?: string
  /** Plain text. Stored verbatim in the queue row's `payload.subject`; HTML-escaped only at the
   * point it is interpolated into an outbound HTML email body. */
  subject: string
  /** Plain text. Stored verbatim in the queue row's `payload.body`; HTML-escaped only at the
   * point it is interpolated into an outbound HTML email body — the plain-text/inbox variants
   * carry the raw string unescaped, matching every existing template's own text-part
   * convention. */
  body: string
}

export type NotificationOriginatorEnqueueResult = {
  /** The inserted `notification_queue` row's id. */
  notificationQueueId: string
}

/**
 * Thrown by `enqueueNotification()` when called with no ambient request context bound (e.g. a
 * call attempted outside any HTTP request lifecycle, such as accidentally from a background
 * job). Mirrors `MonitoringNoAmbientContextError` verbatim — zero DB calls before this throws.
 */
export class NotificationOriginatorNoAmbientContextError extends Error {
  readonly code = 'notification_originator_no_ambient_context'

  constructor() {
    super(
      'HostServices.notificationOriginator.enqueueNotification() was called with no ambient request context bound'
    )
    this.name = 'NotificationOriginatorNoAmbientContextError'
  }
}

/**
 * Thrown when `channel`/`subject`/`body`/recipient-field shape is malformed: `channel` not one
 * of the two legal values; `subject`/`body` empty, non-string, or over their size caps; neither
 * or both of `recipientUserId`/`recipientEmail` supplied; or `recipientEmail` supplied for
 * `channel: 'inbox'`. Thrown before any DB call.
 */
export class NotificationOriginatorInvalidParamsError extends Error {
  readonly code = 'notification_originator_invalid_params'

  constructor(message: string) {
    super(`HostServices.notificationOriginator.enqueueNotification() rejected: ${message}`)
    this.name = 'NotificationOriginatorInvalidParamsError'
  }
}

/**
 * Thrown when `recipientUserId` does not resolve to an active member of the ambient org — either
 * because the id does not exist at all, or because it belongs to a real user who is not an
 * active member of the ambient org (including a real member of a DIFFERENT org). The message is
 * deliberately **non-enumerating**: never a distinguishable "user not found" vs. "user not in
 * this org" — mirrors `DeliveryProvider.verifyWebhookSignature()`'s "never throws for an
 * ordinary invalid signature, resolves false instead, so the route can respond with a single,
 * non-enumerating rejection shape" precedent, adapted to a thrown-error API instead of a
 * boolean-returning one.
 */
export class NotificationOriginatorInvalidRecipientError extends Error {
  readonly code = 'notification_originator_invalid_recipient'

  constructor() {
    super(
      'HostServices.notificationOriginator.enqueueNotification() rejected: recipientUserId does not resolve to an active member of the ambient organization'
    )
    this.name = 'NotificationOriginatorInvalidRecipientError'
  }
}

/**
 * Thrown when the calling extension has already reached its per-(extension, org) rolling-window
 * enqueue cap. **Best-effort, not a hard invariant** — the cap is enforced via a check-then-act
 * `COUNT(*)` query against `notification_queue` (chosen over an in-memory counter specifically
 * because a process restart must not reset the cap). Two concurrent calls racing right at the
 * cap boundary may both read a count just under the cap and both succeed (a small overshoot),
 * which is accepted: this cap bounds gross, sustained abuse, it does not enforce an exact quota.
 * Closing this completely would require a `SELECT ... FOR UPDATE`-serialized counter row per
 * (extensionName, orgId), which is more machinery than this cap's own stated goal justifies.
 */
export class NotificationOriginatorRateLimitedError extends Error {
  readonly code = 'notification_originator_rate_limited'

  constructor() {
    super(
      'HostServices.notificationOriginator.enqueueNotification() rejected: per-(extension, org) rolling-window enqueue cap reached'
    )
    this.name = 'NotificationOriginatorRateLimitedError'
  }
}

/**
 * Story 36.1 — the real `HostServices.notificationOriginator` field. See this module's doc
 * comment for the full directionality/reuse/scoping/rate-limit rationale.
 */
export type NotificationOriginatorHost = {
  enqueueNotification(
    params: NotificationOriginatorEnqueueParams
  ): Promise<NotificationOriginatorEnqueueResult>
}
