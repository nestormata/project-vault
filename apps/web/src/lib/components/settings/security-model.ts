export function isValidTotpInput(value: string): boolean {
  return /^\d{6}$/.test(value)
}

// The backend returns the enrollment QR as inline SVG markup, but this app's static-hardening
// test bans raw HTML rendering directives outright (no HTML injection surface, ever). Encoding
// it as a data URI and rendering it through a plain <img> gets the same visual result instead.
export function qrCodeDataUri(svg: string): string {
  return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`
}

export function formatEnrolledAt(value: string | null): string {
  if (!value) return '—'
  return new Date(value).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function describeRemainingRecoveryCodes(count: number | null): string {
  if (count === null) return ''
  if (count === 0) return 'No unused recovery codes remain — regenerate a fresh batch.'
  if (count === 1) return '1 unused recovery code remains.'
  return `${count} unused recovery codes remain.`
}
