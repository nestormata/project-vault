// Story 6.3: shared display helpers for a monitored service's health status. Used by both the
// authenticated cross-project health dashboard and the public status page — the underlying status
// literal ('healthy' | 'degraded' | 'down') is intentionally duplicated at the schema layer (see
// packages/shared/src/schemas/health-dashboard.ts) but the *display* logic (badge color, "checked
// at" formatting) has exactly one home here to avoid drift between the two surfaces.
export type ServiceHealthStatus = 'healthy' | 'degraded' | 'down'

export function statusClass(status: ServiceHealthStatus): string {
  switch (status) {
    case 'healthy':
      return 'bg-emerald-100 text-emerald-800'
    case 'degraded':
      return 'bg-amber-100 text-amber-900'
    case 'down':
      return 'bg-red-100 text-red-800'
  }
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
