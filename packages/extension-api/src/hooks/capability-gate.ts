/**
 * AC1/AC2 — `CapabilityGate` is the fourth typed hook interface this package exports, alongside
 * `AuthStrategy`, `NotificationChannel`, and `UIPanel`. It answers exactly one question: "may this
 * organization use capability X at all?" (entitlement). It cannot express quota — see the story's
 * Dev Notes § Rejected alternatives.
 *
 * **`gateCallId`, not `requestId` — mandatory security rationale.** `apps/api/src/app.ts` sets
 * `requestIdHeader: false` and a custom `genReqId()` that accepts a caller-supplied `X-Request-ID`
 * verbatim whenever it matches a UUID v4 pattern. Fastify's `request.id` is therefore
 * *attacker-controlled input*: a caller can pin one UUID across thousands of requests (defeating
 * correlation and any extension-side per-request keying) or reuse an unrelated request's id to
 * forge a correlation trail. PV must never hand that value to a third-party extension as if it
 * were trustworthy. `checkCapability()` therefore mints a fresh `randomUUID()` per invocation as
 * `gateCallId`, and every `CAPABILITY_GATE_*` operational log line carries both `gateCallId`
 * (trusted, PV-minted) and `requestId` (untrusted, echoed for operator convenience only).
 *
 * **Why this is tier-agnostic.** PV sends an opaque capability *name it itself owns* plus
 * identifiers it already has, and receives a boolean plus an opaque string it never interprets.
 * Every notion of tier, plan, quota, entitlement source, billing state, or grace period lives
 * entirely inside the extension's `onCheckCapability()` implementation. Adding a paid tier,
 * changing tier names, or replacing the billing system requires zero PV changes. The invariant is
 * enforced by (a) `capability-gate.test.ts`'s exact-key shape tests and (b)
 * `capability-ids.test.ts`'s golden id list — never by a token grep (see AC-3's Dev Notes for why
 * every grep variant, at every scope, was tried and removed).
 */

/** An opaque, PV-domain capability identifier — never a tier/plan name. */
export type CapabilityDecision =
  | { permitted: true }
  | {
      permitted: false
      /** Opaque to PV. Echoed in logs/audit and to the client verbatim; PV NEVER branches on it. */
      reasonCode: string
      /**
       * Optional human-readable copy the UI may render verbatim as escaped plain text.
       * NOT localized by PV and NOT localizable by the extension — `CapabilityGateContext` carries
       * no `locale` field, so an extension physically cannot localize this string.
       */
      message?: string
    }

export type CapabilityGateContext = {
  /** PV-owned capability identifier, e.g. "monitoring.public-status-page". */
  capability: string
  /** Organization the request resolved to, or null for unauthenticated/public surfaces. */
  orgId: string | null
  /** Acting user, or null for unauthenticated/public surfaces. */
  userId: string | null
  /** PV's already-resolved org role, informational only, or null when not org-scoped. */
  orgRole: 'owner' | 'admin' | 'member' | 'viewer' | null
  /**
   * PV-generated, unguessable, one per gate invocation. NEVER caller-controlled and NEVER
   * Fastify's `request.id` — see the security note above. Correlate with PV's own request log via
   * the CAPABILITY_GATE_* operational log lines, which carry both ids.
   */
  gateCallId: string
}

export type CapabilityGate = {
  onCheckCapability(context: CapabilityGateContext): Promise<CapabilityDecision>
}
