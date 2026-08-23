/**
 * Story 23.9 — a host-provided service, same directionality as `AuditEventSourceHost`
 * (Story 23.8): PV implements `checkMembership()` and hands a bound instance to the extension
 * via `HostServices` (see `host-services.ts`). It does NOT belong in `ExtensionHooks` alongside
 * the extension-implemented hooks (`AuthStrategy`, `NotificationChannel`, `UIPanel`,
 * `CapabilityGate`) — this is PV answering a question for the extension, not the extension
 * implementing behavior for PV.
 *
 * `minimumRole` reuses PV's own existing internal role enum (`owner` > `admin` > `member` >
 * `viewer`) rather than a capability string — capability/tier gating is Story 23.3's
 * `CapabilityGate` hook's job; this hook answers only "is this identity currently a member of
 * this org with at least this role," never "does this org's tier include some capability."
 */
export type OrgAuthorizationCheckContext = {
  organizationId: string
  viewerIdentityId: string
  minimumRole: 'owner' | 'admin' | 'member' | 'viewer'
}

/**
 * Never thrown to the caller — every failure mode this hook can encounter (missing org/identity,
 * a non-active membership, an internal resolution error, or an out-of-enum `minimumRole` at
 * runtime) resolves to one of these three outcomes.
 *
 * `reasonCode` is diagnostic text only, not a stable, pattern-matchable contract — only the
 * `outcome` discriminant values (`'authorized' | 'denied' | 'error'`) are part of this type's
 * contract. A future wording change to a `reasonCode` string is not a breaking change.
 */
export type OrgAuthorizationOutcome =
  | { outcome: 'authorized' }
  | { outcome: 'denied'; reasonCode: string }
  | { outcome: 'error'; reasonCode: string }

/**
 * Request-scoped and re-evaluated on every call — never cached or memoized across calls, even
 * though the bound function reference itself is constructed once, at extension-load time
 * (`loader.ts`'s `buildHostServices()`), and reused across every subsequent request.
 */
export type OrgAuthorizationHost = {
  checkMembership(context: OrgAuthorizationCheckContext): Promise<OrgAuthorizationOutcome>
}
