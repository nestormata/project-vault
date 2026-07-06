// Shared small pure helpers for the services/certificates/domains create+edit forms (Story 6.4):
// parsing/converting submitted values (this file) plus display-formatting the loaded record back
// out (also folded in here so every monitored-asset page imports this one module instead of two).

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

// The reverse direction of toIsoDate: an ISO datetime -> the YYYY-MM-DD an <input type="date">
// expects, used to pre-fill an edit form from the loaded record.
export function toDateInputValue(value: string | null): string {
  if (!value) return ''
  return value.slice(0, 10)
}

export function formatDate(value: string | null): string {
  if (!value) return '—'
  return new Date(value).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

export function formatAlertLeadDays(days: number[]): string {
  if (days.length === 0) return '—'
  return `Alerts at ${days.join(', ')} days before`
}

// Client-side pre-checks shared between a create form and its matching edit form (both call the
// same server-side validation too — these just give faster, no-network-round-trip feedback).

export function validateCertificateFields(
  domain: string,
  expiresAt: string,
  options: { maxDomainLength?: number } = {}
): { domain?: string; expiresAt?: string } {
  const errors: { domain?: string; expiresAt?: string } = {}
  if (!domain.trim()) errors.domain = 'Domain is required'
  else if (
    options.maxDomainLength !== undefined &&
    domain.trim().length > options.maxDomainLength
  ) {
    errors.domain = `Domain must be ${options.maxDomainLength} characters or fewer`
  }
  if (!expiresAt) errors.expiresAt = 'Expiry date is required'
  return errors
}

export function validateDomainFields(
  domainName: string,
  renewalDate: string
): { domainName?: string; renewalDate?: string } {
  const errors: { domainName?: string; renewalDate?: string } = {}
  if (!domainName.trim()) errors.domainName = 'Domain name is required'
  if (!renewalDate) errors.renewalDate = 'Renewal date is required'
  return errors
}
