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
}

export type AuditEventSourceWriteResult = { id: string; createdAt: string }

/**
 * **Tenant isolation, not tenant authorization (AC-17).** PV performs tenant isolation via RLS
 * once you call this with an `orgId` — PV does NOT verify you were authorized to act on that
 * orgId. That authorization is the calling extension's own responsibility, exactly as it is for
 * every other line of code an in-process extension executes today.
 *
 * **No idempotency (AC-20).** Calling this twice for what you consider "the same" event writes
 * two rows. If your extension's own retry logic can double-call this, de-duplicate on your side
 * before calling, or accept two rows — PV's audit log has always been append-only-of-record, not
 * a dedup service, even for its own host-originated writes.
 */
export type AuditEventSourceHost = {
  writeAuditEvent(input: AuditEventSourceWriteInput): Promise<AuditEventSourceWriteResult>
}
