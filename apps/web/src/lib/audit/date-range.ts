// HTML <input type="date"> yields "YYYY-MM-DD"; every audit date-range field this story's API
// wrappers send is a full ISO datetime string per schema.ts's z.iso.datetime() (mirrors
// apps/web/src/lib/monitoring/form-helpers.ts's toIsoDate for the same reason).
export function toIsoRangeStart(value: string): string {
  return `${value}T00:00:00.000Z`
}

export function toIsoRangeEnd(value: string): string {
  return `${value}T23:59:59.999Z`
}

// AC-B2 — blocks submission client-side ("End date must be after start date") before any network
// call when `to` is before `from`; mirrors the existing credentials/new-style pre-check pattern
// (Story 6.4's convention). Blank inputs are not yet an error (nothing to compare).
export function validateDateRange(from: string, to: string): string | null {
  if (!from || !to) return null
  return new Date(from).getTime() > new Date(to).getTime()
    ? 'End date must be after start date'
    : null
}
