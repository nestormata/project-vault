// Story 6.3: shared display helpers for a monitored service's health status. Used by both the
// authenticated cross-project health dashboard and the public status page — the underlying status
// literal ('healthy' | 'degraded' | 'down') is intentionally duplicated at the schema layer (see
// packages/shared/src/schemas/health-dashboard.ts) but the *display* logic (badge color, "checked
// at" formatting) has exactly one home here to avoid drift between the two surfaces.
export type ServiceHealthStatus = 'healthy' | 'degraded' | 'down'

const NEUTRAL_BADGE_CLASS = 'bg-slate-100 text-slate-700'

const STATUS_BADGE_CLASSES: Record<ServiceHealthStatus, string> = {
  healthy: 'bg-emerald-100 text-emerald-800',
  degraded: 'bg-amber-100 text-amber-900',
  down: 'bg-red-100 text-red-800',
}

// Story 18.13: a keyed lookup rather than a switch, so adding a member to ServiceHealthStatus is
// still a compile error here, while an off-contract runtime value (the API enum says it cannot
// happen, but a badge is not worth trusting it for) falls back to a neutral badge instead of
// stringifying `undefined` into the class attribute.
//
// hasOwn, not a bare index + `??`: plain-object lookup walks the prototype, so a status of
// 'constructor' or 'toString' would resolve to an inherited function and stringify it into the
// class attribute — the exact failure the fallback exists to prevent.
export function statusClass(status: ServiceHealthStatus): string {
  return Object.hasOwn(STATUS_BADGE_CLASSES, status)
    ? STATUS_BADGE_CLASSES[status]
    : NEUTRAL_BADGE_CLASS
}

export function formatCheckedAt(value: string | null): string {
  if (!value) return 'Not checked yet'
  return new Date(value).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

// Story 28.7 AC5/AC6/AC7: the shared badge label, gated on `lastCheckedAt` — a never-checked
// endpoint (`lastCheckedAt === null`) must not assert a real `healthy`/`degraded`/`down` outcome
// it hasn't earned yet. This is a display-only gate: the underlying `status` value itself is
// untouched (still correctly `'healthy'` per ADR-6.2-03's consecutiveFailures=0 default), so no
// schema/data-model change is involved.
export const PENDING_CHECK_LABEL = 'Pending first check'

export function statusBadgeLabel(
  status: ServiceHealthStatus,
  lastCheckedAt: string | null
): string {
  return lastCheckedAt === null ? PENDING_CHECK_LABEL : status
}

// Story 28.7 AC5/AC6: same `lastCheckedAt` gate applied to the badge's styling — reuses the
// existing off-contract-status fallback (`NEUTRAL_BADGE_CLASS`, via `statusClass`) rather than
// inventing new styling for the pending state.
export function statusBadgeClass(
  status: ServiceHealthStatus,
  lastCheckedAt: string | null
): string {
  return lastCheckedAt === null ? NEUTRAL_BADGE_CLASS : statusClass(status)
}
