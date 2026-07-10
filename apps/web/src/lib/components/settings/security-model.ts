export function isValidTotpInput(value: string): boolean {
  return /^\d{6}$/.test(value)
}

// The backend returns the enrollment QR as inline SVG markup, but this app's static-hardening
// test bans raw HTML rendering directives outright (no HTML injection surface, ever). Encoding
// it as a data URI and rendering it through a plain <img> gets the same visual result instead.
export function qrCodeDataUri(svg: string): string {
  // `unescape` is deprecated; this is the standard non-deprecated replacement for turning a
  // UTF-8 string into the Latin1-range byte string btoa() requires.
  const utf8Bytes = encodeURIComponent(svg).replace(/%([0-9A-F]{2})/g, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16))
  )
  return `data:image/svg+xml;base64,${btoa(utf8Bytes)}`
}

export { formatDateTime as formatEnrolledAt } from '$lib/datetime.js'

export function describeRemainingRecoveryCodes(count: number | null): string {
  if (count === null) return ''
  if (count === 0) return 'No unused recovery codes remain — regenerate a fresh batch.'
  if (count === 1) return '1 unused recovery code remains.'
  return `${count} unused recovery codes remain.`
}
