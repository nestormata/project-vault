// Shared small pure helpers for the services/certificates/domains create+edit forms (Story 6.4).

// HTML <input type="date"> yields "YYYY-MM-DD"; every date-typed field this story's API wrappers
// send (renewalDate, expiresAt) is a full ISO datetime string per schema.ts's z.iso.datetime().
export function toIsoDate(value: string): string {
  return `${value}T00:00:00.000Z`
}

// AC-B3 edge: "Alert me before renewal (days)" accepts a comma-separated list (e.g. "30, 14, 3").
// Returns undefined for blank input so the field is omitted from the request body entirely,
// letting the server apply its own per-resource default rather than sending an empty array.
export function parseAlertLeadDaysInput(raw: string): number[] | undefined {
  const parsed = raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => Number(part))
    .filter((n) => Number.isFinite(n))
  return parsed.length > 0 ? parsed : undefined
}
