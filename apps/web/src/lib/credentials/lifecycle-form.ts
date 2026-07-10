// Credential-local date <-> ISO helpers for the Lifecycle edit form (AC-L1). Deliberately not
// importing `$lib/monitoring/form-helpers.ts` — same shape, but that module belongs to a
// different domain (certificates/domains) and this story's Dev Notes call out avoiding that
// cross-domain coupling.

export function toLifecycleDateInputValue(value: string | null): string {
  if (!value) return ''
  return value.slice(0, 10)
}

// AC-L1 edge: a blank date input converts to an explicit `null`, not an empty string or an
// omitted field, so "clear the expiry" is reachable and distinct from "leave unchanged".
export function lifecycleDateInputToIso(value: string): string | null {
  return value ? `${value}T00:00:00.000Z` : null
}
