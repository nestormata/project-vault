/**
 * Story 43.8 AC-7 — strict `Retry-After` handling for a server (or reverse-proxy) 429.
 *
 * Only a plain integer number of seconds (1–5 digits) is accepted, clamped to [1, 3600]. An
 * HTTP-date, a negative/decimal/exponent value, trailing junk or terminal escapes all yield `null`,
 * which callers render as "later". The raw header value is never echoed to the terminal — only the
 * integer this function returns is — so no sanitizer is involved (see Story 43.13).
 */
const RETRY_AFTER_PATTERN = /^\d{1,5}$/
const MIN_RETRY_SECONDS = 1
const MAX_RETRY_SECONDS = 3600

export function parseRetryAfter(raw: string | null | undefined): number | null {
  if (typeof raw !== 'string' || !RETRY_AFTER_PATTERN.test(raw)) return null
  return Math.min(MAX_RETRY_SECONDS, Math.max(MIN_RETRY_SECONDS, Number(raw)))
}

/** Reads `Retry-After` from a fetch Response; tolerates response-like objects without headers. */
export function retryAfterFromResponse(response: Response): number | null {
  const headers = (response as { headers?: Headers }).headers
  return parseRetryAfter(headers ? headers.get('retry-after') : null)
}

/** "in 37 seconds" / "in 1 second" / "later". */
export function retryDelayPhrase(retryAfterSeconds: number | null): string {
  if (retryAfterSeconds === null) return 'later'
  return `in ${retryAfterSeconds} second${retryAfterSeconds === 1 ? '' : 's'}`
}
