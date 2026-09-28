/**
 * Story 60.4 AC3/AC6: the origin the /handoff consent page's "Return to CentralizeMe" guidance
 * links to, derived ONLY from operator configuration (the web process's own
 * `VAULT_HANDOFF_ISSUER`) — never from the page's query string, since an attacker-controlled href
 * on a consent page is a phishing primitive.
 *
 * Only an absolute `http:`/`https:` URL without credentials yields a value, and only its origin is
 * returned (path/query/hash dropped). Anything else — unset, blank, unparsable, another scheme, or
 * a userinfo trick such as `https://app.centralizeme.com@evil.test` — returns `null`, and the page
 * falls back to plain-text guidance. Pure: callers resolve it per request, never cache it.
 */
export function resolveCentralizeMeOrigin(raw: string | undefined): string | null {
  const trimmed = raw?.trim()
  if (!trimmed) return null

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.username || url.password) return null
  return url.origin
}
