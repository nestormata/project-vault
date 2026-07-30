/**
 * Builds an absolute URL from a trusted origin and an app-relative path. Centralizes "build
 * absolute app URL from path" so every shared/generated link (credential shares, public status
 * page, invitation/recovery links, etc.) uses the exact same construction instead of each caller
 * reimplementing origin + path concatenation ad hoc (Story 18.2 AC-3).
 *
 * Framework-agnostic on purpose (no `$app/paths`/SvelteKit import) so it's usable from both
 * `apps/web` (passing the request's resolved `url.origin`) and, if a future story needs it,
 * `apps/api` (passing `env.WEB_BASE_URL`).
 *
 * Throws rather than silently building a broken `https://undefined/...`-shaped link when origin
 * is missing, empty, or not a well-formed http(s) origin (Story 18.2 AC-5) — callers should let
 * this fail loudly (uncaught in dev/tests, or surfaced as a real error) instead of rendering a
 * link that looks legitimate but doesn't resolve anywhere.
 */
/**
 * Validates that `origin` is a well-formed, non-empty http(s) origin and returns its normalized
 * form (via `URL#origin`, which discards any path/query/hash the caller mistakenly included).
 * Throws a plain `Error` otherwise.
 *
 * This is the single source of truth for "is this origin trustworthy enough to build a link
 * from" — shared by `buildAbsoluteUrl` below and by each SvelteKit route's load-time guard, so
 * the two can never drift out of sync (previously each route reimplemented this check with a
 * strictly weaker regex that could accept values `buildAbsoluteUrl` would still reject later).
 */
export function assertTrustedOrigin(origin: string): string {
  if (!origin || typeof origin !== 'string') {
    throw new Error(
      `assertTrustedOrigin: origin must be a non-empty string, got: ${String(origin)}`
    )
  }

  let parsedOrigin: URL
  try {
    parsedOrigin = new URL(origin)
  } catch {
    throw new Error(`assertTrustedOrigin: origin is not a valid absolute URL: ${origin}`)
  }

  if (parsedOrigin.protocol !== 'http:' && parsedOrigin.protocol !== 'https:') {
    throw new Error(`assertTrustedOrigin: origin must use http or https, got: ${origin}`)
  }

  return parsedOrigin.origin
}

export function buildAbsoluteUrl(origin: string, path: string): string {
  const trustedOrigin = assertTrustedOrigin(origin)
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${trustedOrigin}${normalizedPath}`
}
