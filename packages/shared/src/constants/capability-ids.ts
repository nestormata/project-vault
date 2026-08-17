/**
 * Story 23.3 AC-22 — a PV-owned, enumerated, closed set of capability-gate ids. `secureRoute()`'s
 * `security.capability` and `assertCapability()` accept only these values; an id not in this set
 * fails CLOSED (never silently ungated) — see `apps/api/src/lib/capability-gate.ts`.
 *
 * This story registers exactly one id: the concrete example named in ADR 0005. Growing this list
 * is a reviewable, one-line diff — see `capability-ids.test.ts`'s golden array assertion (AC-3(b)).
 */
export const CapabilityId = {
  MONITORING_PUBLIC_STATUS_PAGE: 'monitoring.public-status-page',
} as const

export type CapabilityIdValue = (typeof CapabilityId)[keyof typeof CapabilityId]
