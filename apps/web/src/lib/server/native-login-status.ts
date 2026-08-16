/**
 * Story 23.2 AC-13: server-side resolution of `GET /api/v1/health`'s `nativeLoginEnabled`
 * field for the pre-auth pages (`/login`, `/register`, `/recovery`, `/recovery/[token]`,
 * `/invitations/accept`) — the field the login screen reads to decide whether to render the
 * password form at all, before the user has typed anything.
 *
 * Two deliberate resilience properties (finding N14): a 1s fetch timeout, and a 60s
 * last-known-good in-memory cache, so a transient `/health` blip does not take every pre-auth
 * page down on every request. A cold-start failure (no cache yet) resolves to `null` — the
 * caller's job is to render a neutral, retryable "temporarily unavailable" state for that case,
 * never a password form and never a hard failure.
 */

const FETCH_TIMEOUT_MS = 1000
const CACHE_TTL_MS = 60_000

let cache: { value: boolean; fetchedAt: number } | null = null

/** Test-only: clears the module-level cache between test cases. Never called from production
 * code — there is no request path that could reach it. */
export function __resetNativeLoginStatusCacheForTests(): void {
  cache = null
}

function isCacheFresh(): boolean {
  return cache !== null && Date.now() - cache.fetchedAt < CACHE_TTL_MS
}

/**
 * Resolves whether native login is enabled. Returns:
 * - `true`/`false` from a live, successful `/api/health` call (never consults the cache when the
 *   live call succeeds — always the freshest known value);
 * - the cached value if the live call fails/times out and a fresh (<60s old) cached value exists;
 * - `null` if the live call fails and there is no fresh cached value (cold-start failure).
 *
 * A response body that omits `nativeLoginEnabled` (a version-skew case — an older API build)
 * resolves to `true`, the fail-safe/no-behavior-change direction, matching every other AC-16
 * "no extension configured" default.
 */
export async function resolveNativeLoginEnabled(fetchFn: typeof fetch): Promise<boolean | null> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  try {
    // See apps/web/src/lib/api/platform.ts's fetchHealth() comment: the literal `/health` path
    // collides with this app's own (app)/health monitored-services dashboard route, so the API's
    // liveness endpoint is proxied at `/api/health` instead.
    const response = await fetchFn('/api/health', {
      credentials: 'include',
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`health check returned ${response.status}`)
    const body = (await response.json().catch(() => null)) as {
      nativeLoginEnabled?: boolean
    } | null
    const value = body?.nativeLoginEnabled ?? true
    cache = { value, fetchedAt: Date.now() }
    return value
  } catch {
    return isCacheFresh() ? (cache as { value: boolean }).value : null
  } finally {
    clearTimeout(timeoutId)
  }
}
