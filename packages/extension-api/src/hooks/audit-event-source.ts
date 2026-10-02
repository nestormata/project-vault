/**
 * Story 23.8 Group A — `AuditEventSourceHost` is the FIRST hook type in this package that
 * inverts the direction every prior hook (`AuthStrategy`, `NotificationChannel`, `UIPanel`,
 * `CapabilityGate`) established: those are all things the extension implements and PV calls into.
 * This one is a host-provided service — PV implements `writeAuditEvent()` and hands a bound
 * instance to the extension via `HostServices` (see `host-services.ts`). It does NOT belong in
 * `ExtensionHooks` alongside the other four (see `register-extension.ts`'s `ExtensionHooks` doc
 * comment for the explicit "do not move this" note).
 *
 * PV performs the HMAC signing, key-versioning, and same-transaction insert into
 * `audit_log_entries` it already performs for its own host-originated events — the extension
 * boundary carries serializable data only (AC-2's edge case): no `Tx`, no key material, no
 * `keyVersion`/`hmac` field crosses it in either direction (AC-10).
 */
export type AuditEventSourceWriteInput = {
  /**
   * MUST be prefixed with this extension's own manifest-derived namespace,
   * `ext.<manifest.name>.`, e.g. `ext.com.centralizeme.module-pack.classification_changed`. The
   * prefix is derived from the ACTUALLY LOADED extension's own manifest name at host-construction
   * time — never a value this input itself can override (AC-15).
   */
  eventType: string
  orgId: string
  projectId?: string
  resourceId?: string
  resourceType?: string
  payload: Record<string, unknown>
  /**
   * Optional stable key that makes this write idempotent (since 3.26.0). Matches
   * `^[A-Za-z0-9._:-]{1,128}$`; anything else rejects before any write.
   *
   * With a key, PV remembers the first successful write under the tuple (org, your extension
   * `manifest.name`, key). A later call with the same tuple and identical content writes no row and
   * returns the FIRST call's `{ id, createdAt }`, so a retry after a lost response never produces a
   * second audit row, including under concurrent duplicates. Identical content means the same
   * `eventType`, `resourceType`, `resourceId`, `projectId` and `payload` (object key order is
   * ignored; an `undefined` field equals an absent one; `null` does NOT equal absent). The same key
   * with different content rejects with a non-retryable conflict error and never overwrites or
   * acknowledges. The same key under another org or another extension is an independent key.
   *
   * A replay is not a fresh write: it is not rate-limited or storage-gated (the first write was).
   * A first write that is rejected or rolls back leaves no key, so a retry writes fresh.
   *
   * **Retention.** A key lives exactly as long as the audit row it points at: PV never expires it
   * on a timer, and it disappears only if that audit row is purged by an org's configured audit
   * retention. PV stores a fingerprint of the content, never a copy of the payload.
   *
   * Omit it to keep the original behaviour unchanged: two calls write two rows.
   */
  idempotencyKey?: string
}

export type AuditEventSourceWriteResult = { id: string; createdAt: string }

/**
 * **Tenant isolation, not tenant authorization (AC-17).** PV performs tenant isolation via RLS
 * once you call this with an `orgId` — PV does NOT verify you were authorized to act on that
 * orgId. That authorization is the calling extension's own responsibility, exactly as it is for
 * every other line of code an in-process extension executes today.
 *
 * **Idempotency is opt-in (AC-20, amended by Story 71.1).** By default, calling this twice for
 * what you consider "the same" event writes two rows: PV's audit log is append-only-of-record, not
 * a dedup service. If your delivery channel is at-least-once, pass a stable `idempotencyKey` (see
 * `AuditEventSourceWriteInput.idempotencyKey`) and a retry returns the original receipt instead of
 * writing a second row. Callers that omit the key are unaffected.
 */
export type AuditEventSourceHost = {
  writeAuditEvent(input: AuditEventSourceWriteInput): Promise<AuditEventSourceWriteResult>
}
