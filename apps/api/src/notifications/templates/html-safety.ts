// notification_queue.payload is stored as untyped JSON — every template's payload fields are
// typed as required strings, but a malformed/missing row must not crash render (Story 28.6 AC2,
// same class of bug as security-failed-auth-threshold.ts's AC1 fix).
export function escapeHtml(str: string | undefined | null): string {
  const safe = typeof str === 'string' ? str : ''
  return safe
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

// Code-review fix (post-28.6) — escapeHtml only neutralizes markup characters, it does not
// restrict the URL scheme. Since URL-shaped payload fields (e.g. recoveryUrl/acceptUrl) come
// from an untyped, unrevalidated notification_queue.payload row, a malformed/tampered row
// containing a `javascript:`/`data:` URI must not be allowed to render as a clickable href in
// these security-sensitive emails.
export function safeHref(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? url : ''
  } catch {
    return ''
  }
}
