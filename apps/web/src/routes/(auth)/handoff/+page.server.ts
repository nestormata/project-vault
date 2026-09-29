import { dev } from '$app/environment'
import { env } from '$env/dynamic/private'
import { proxyApiRequest } from '$lib/server/api-proxy.js'
import { internalApiFetch } from '$lib/server/internal-api-tls.js'
import { resolveCentralizeMeOrigin } from '$lib/server/handoff-return-origin.js'
import type { PageServerLoad } from './$types'

// Matches handoff-routes.ts's own HANDOFF_COOKIE_NAME constant exactly — apps/web does not
// import from apps/api's internals anywhere else in this codebase (Dev Notes), so this is a
// deliberate duplicated literal, not an import.
const HANDOFF_COOKIE_NAME = 'handoff-confirm'

type ExchangeClaimResponseBody = {
  data?: { rawCookieValue?: unknown; expiresAt?: unknown }
}

async function exchangeClaim(
  fetchFn: typeof fetch,
  apiBaseUrl: string | undefined,
  pendingId: string,
  claim: string
): Promise<Response | null> {
  try {
    return await proxyApiRequest({
      fetchFn,
      request: new Request('https://handoff.internal/exchange-claim', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pendingId, claim }),
      }),
      path: 'auth/handoff/exchange-claim',
      apiBaseUrl,
    })
  } catch {
    return null
  }
}

/** Returns `null` when the response carries no usable, still-live cookie value to set. */
async function parseExchangeResult(
  response: Response
): Promise<{ rawCookieValue: string; remainingMs: number } | null> {
  if (!response.ok) return null

  const body = (await response.json().catch(() => null)) as ExchangeClaimResponseBody | null
  const rawCookieValue = body?.data?.rawCookieValue
  const expiresAtRaw = body?.data?.expiresAt
  if (typeof rawCookieValue !== 'string' || typeof expiresAtRaw !== 'string') return null

  // AC3: the REMAINING TTL, not a fresh 120s — a claim exchange must never let the pending
  // state's effective life extend past its original expiry.
  const remainingMs = new Date(expiresAtRaw).getTime() - Date.now()
  if (remainingMs <= 0) return null

  return { rawCookieValue, remainingMs }
}

/**
 * Story 60.3 AC3/AC6 — Option 1's claim-exchange consumption. CentralizeMe's interstitial (once it
 * ships the contract change in AC5) navigates the browser (top-level) to
 * `/handoff?pendingId=...&claim=...`. This `load` runs same-origin on PV's own server, so it can
 * set the `handoff-confirm` cookie with `sameSite: 'strict'` and have it actually survive — unlike
 * `prepare()`'s own cookie-set, which is dropped by the browser on the cross-site response that
 * bug F2 is about.
 *
 * Design decision (AC3, Dev Notes): calls apps/api directly via the same `proxyApiRequest()`
 * pattern `prepare/+server.ts` already uses, rather than talking to the DB/`SSO_STATE_HMAC_SECRET`
 * from apps/web directly — apps/web has neither today, and giving it either would be a new,
 * unreviewed cross-service coupling. All of the insert-first-burn consumption, the org-scoped
 * lookup, and the security-event audit logging for every failure path live in apps/api's own
 * `handleExchangeClaim()` (mirroring `handleConfirm()`'s existing shape) — this `load` only relays
 * the outcome and, on success, sets the browser cookie itself.
 *
 * A missing/empty `pendingId` or `claim`, a non-2xx response, a malformed response body, or an
 * already-expired remaining TTL all fall through to doing nothing — the existing `+page.svelte`
 * (unchanged by this story) already renders its own neutral rejection state whenever no valid
 * session materializes, so this `load` never needs to itself distinguish or surface *why* no
 * cookie was set.
 */
export const load: PageServerLoad = async (event) => {
  await exchangeClaimIntoCookie(event)

  // Story 60.4 AC3: resolved per request from the web process's own env (never cached, never
  // read from the query string), whatever the claim exchange's outcome.
  return { centralizeMeOrigin: resolveCentralizeMeOrigin(env.VAULT_HANDOFF_ISSUER) }
}

async function exchangeClaimIntoCookie(event: Parameters<PageServerLoad>[0]): Promise<void> {
  const pendingId = event.url.searchParams.get('pendingId')
  const claim = event.url.searchParams.get('claim')
  if (!pendingId || !claim) return

  const response = await exchangeClaim(internalApiFetch, env.API_BASE_URL, pendingId, claim)
  const result = response && (await parseExchangeResult(response))
  if (!result) return

  event.cookies.set(HANDOFF_COOKIE_NAME, result.rawCookieValue, {
    httpOnly: true,
    // Same-origin here (unlike prepare()'s cross-site-dropped cookie), so Strict actually
    // survives — matches prepare()'s own sameSite choice (AC3.7's rationale still applies).
    sameSite: 'strict',
    secure: !dev,
    path: '/',
    maxAge: Math.floor(result.remainingMs / 1000),
  })
}
