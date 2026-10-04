// Single source of truth for the "Mon D, YYYY, HH:MM" timestamp formatting used across rotation
// and settings/security views (jscpd flagged the drift between independent copies).
export function formatDateTime(value: string | null): string {
  if (!value) return '—'
  return new Date(value).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** "Mon D, YYYY" for a date-only display (the dashboard and project cards). */
export function formatDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}
