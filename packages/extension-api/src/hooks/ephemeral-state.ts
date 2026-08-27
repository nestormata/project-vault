/**
 * Story 20.8 — the delivery half of `20-7-pv-ephemeral-extension-state-store-and-cleanup-hook`,
 * which shipped only the approved "Ephemeral Extension State Store & Cleanup Hook Contract"
 * decision text in `architecture.md`; this type is that decision's first concrete code artifact.
 *
 * Same directionality as `AuditEventSourceHost` (Story 23.8) and `OrgAuthorizationHost`
 * (Story 23.9): PV implements every method here and hands a bound instance to the extension via
 * `HostServices` (see `../host-services.ts`). It does NOT belong in `ExtensionHooks` — this is PV
 * answering/servicing the extension, not the extension implementing behavior for PV.
 *
 * Namespacing (20-7 AC-5): every key is implicitly scoped to
 * `(extensionNamespace, orgId, key)` at the host storage layer. `orgId` is never a parameter on
 * any method here — it is resolved ambiently by the host from the current request's bound
 * context (`apps/api/src/lib/request-context.ts`'s `getRequestContext()`), exactly as
 * `OrgAuthorizationHost.checkMembership()`'s `organizationId` was removed in Story 23.11.
 * `extensionNamespace` is derived host-side from the loaded extension's own manifest name — an
 * extension supplies only the bare `key`.
 *
 * TTL (20-7 AC-4): every `set`/`compareAndSwap` call requires `ttlSeconds` in the inclusive range
 * `(0, 3600]` — the host throws (never clamps) on a violating value.
 *
 * Fail-closed (20-7 AC-8): every method rejects (throws) on host/store unavailability or when no
 * ambient request context is bound — never a default/empty-value return, never an in-memory or
 * extension-local fallback.
 *
 * `compareAndDelete` (Story 20.8 AC-2 — the one decision this story adds beyond 20-7's contract,
 * closing 20-7 AC-3's explicitly acknowledged gap): atomically deletes the row and resolves
 * `true` only if the entry currently exists, is not expired, and its value strictly equals
 * `expectedValue`; resolves `false` (no delete) on any mismatch, absence, or expiry — the same
 * "expired counts as absent" semantics `compareAndSwap` already uses.
 */
export type EphemeralStateHost = {
  /** Throws if `ttlSeconds` is not in `(0, 3600]`, if `key`/`value` exceed their size bounds, if
   * the per-org live-entry cap (1,000) would be exceeded by a count-increasing write, or on any
   * store/host failure. Overwriting an already-live key never counts against the cap. */
  set(key: string, value: string, ttlSeconds: number): Promise<void>
  /** Resolves `undefined` for a missing OR expired (but not yet swept) entry — reads apply a
   * query-time `expires_at > now()` filter for zero logical staleness. Throws on store/host
   * failure, never falls back to `undefined` in that case. */
  get(key: string): Promise<string | undefined>
  /** Deletes the entry unconditionally if present; a no-op (not an error) if absent or already
   * expired. Throws only on store/host failure. Has no race-free conditional-discard semantics —
   * use `compareAndDelete` when a concurrency-safe discard is required. */
  delete(key: string): Promise<void>
  /** Atomically transitions the entry to `newValue` (with a fresh `ttlSeconds`) only if its
   * current value strictly equals `expectedValue` — `expectedValue: null` means "only if the key
   * does not currently exist (or is expired)". Resolves `true` on a successful transition,
   * `false` on any mismatch/absence-mismatch. Never implemented via a separate read-then-write —
   * a single atomic statement. Throws on store/host failure. */
  compareAndSwap(
    key: string,
    expectedValue: string | null,
    newValue: string,
    ttlSeconds: number
  ): Promise<boolean>
  /** Atomically deletes the entry only if it currently exists, is not expired, and its value
   * strictly equals `expectedValue`. Resolves `true` on a successful delete, `false` on any
   * mismatch, absence, or expiry. Throws on store/host failure. */
  compareAndDelete(key: string, expectedValue: string): Promise<boolean>
}
