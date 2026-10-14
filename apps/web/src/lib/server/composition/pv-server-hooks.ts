// Story 68.6 AC-4 — PV's own server `handle`, as a factory so the composition can place it in the
// chain (`[...before, wrap ? wrap(pv) : pv, ...after]`) and a full override of hooks.server.ts can
// rebuild PV's pipeline around its own code. The logic is `main`'s `appHandle` + Paraglide wrapper
// moved verbatim, with two changes: the `event.setHeaders` call moved to `composeHandles` (the one
// header-setting point), and "protected?" is answered by `isProtectedRequest` (route-id aware).
// The AC-5 whole-response oracle proves PV's behaviour is otherwise unchanged.
import type { Handle } from '@sveltejs/kit'
import { isAuthPath, resolveAuthContext, type AuthGuardResult } from '$lib/server/auth-guard.js'
import { getVaultReadiness } from '$lib/api/vault.js'
import { createServerApiFetch } from '$lib/server/server-api-fetch.js'
import { paraglideMiddleware } from '$lib/paraglide/server.js'
import {
  isBackendAuthenticatedRoute,
  isProtectedRequest,
  type ProtectedPaths,
  type ProtectedRequest,
} from '$lib/server/protected-paths.js'

export interface PvHandleOptions {
  /** Read per request (hooks.server.ts passes `() => env.API_BASE_URL`). */
  apiBaseUrl: () => string | undefined
  protectedPaths: ProtectedPaths
}

function withMutableHeaders(response: Response): Response {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
  })
}

function appendAll(response: Response, setCookies: string[]) {
  for (const setCookie of setCookies) response.headers.append('set-cookie', setCookie)
  return response
}

function appendSetCookies(response: Response, setCookies: string[]) {
  if (setCookies.length === 0) return response
  try {
    return appendAll(response, setCookies)
  } catch {
    // Code review 68-6: a contributed `after`/`wrap` handle may return a Response whose headers are
    // immutable (`Response.redirect()`, a proxied `fetch()`); the first append throws before any
    // change, so copy it (same status, status text, headers and body stream) and append there.
    return appendAll(withMutableHeaders(response), setCookies)
  }
}

function redirectWithCookies(location: string, setCookies: string[]) {
  return appendSetCookies(new Response(null, { status: 303, headers: { location } }), setCookies)
}

type UnavailableAuth = Extract<AuthGuardResult, { status: 'unavailable' }>

const UNAVAILABLE_MESSAGE = 'Authentication is temporarily unavailable. Please retry.'
const UNAVAILABLE_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Temporarily unavailable</title></head>' +
  `<body><h1>Temporarily unavailable</h1><p>${UNAVAILABLE_MESSAGE}</p></body></html>`

/**
 * Story 68-27 — the auth API could not answer (429, 5xx, transport). The session state is unknown,
 * so a protected request is refused with a retryable status, never redirected to /login. Fixed
 * body, no upstream content or headers relayed (only the sanitized Retry-After).
 */
function authUnavailableResponse(
  auth: UnavailableAuth,
  wantsHtml: boolean,
  setCookies: string[]
): Response {
  const headers = new Headers({
    'cache-control': 'no-store',
    'content-type': wantsHtml ? 'text/html; charset=utf-8' : 'application/json',
  })
  if (auth.retryAfter !== undefined) headers.set('retry-after', auth.retryAfter)
  const body = wantsHtml
    ? UNAVAILABLE_HTML
    : JSON.stringify({ code: 'auth_unavailable', message: UNAVAILABLE_MESSAGE })
  const status = auth.category === 'rate_limited' ? 429 : 503
  return appendSetCookies(new Response(body, { status, headers }), setCookies)
}

export function createPvHandle({ apiBaseUrl, protectedPaths }: PvHandleOptions): Handle {
  const isProtected = (req: ProtectedRequest) => isProtectedRequest(protectedPaths, req)

  function shouldCheckVaultReadiness(req: ProtectedRequest) {
    return (
      req.pathname !== '/vault' &&
      (['/', '/login', '/register'].includes(req.pathname) || isProtected(req))
    )
  }

  async function redirectIfVaultUnavailable(fetchFn: typeof fetch, req: ProtectedRequest) {
    if (!shouldCheckVaultReadiness(req)) return null
    const readiness = await getVaultReadiness(fetchFn)
    return readiness.state === 'ready'
      ? null
      : new Response(null, { status: 303, headers: { location: '/vault' } })
  }

  /** The response that ends the request for this auth outcome, or null to resolve it normally. */
  function gateForAuth(
    auth: AuthGuardResult,
    req: ProtectedRequest,
    request: Request,
    setCookies: string[]
  ): Response | null {
    if (auth.status === 'unavailable') {
      const wantsHtml = request.headers.get('accept')?.includes('text/html') === true
      return isProtected(req) ? authUnavailableResponse(auth, wantsHtml, setCookies) : null
    }
    if (auth.status === 'unauthenticated') {
      if (!isProtected(req)) return null
      const reason = auth.reason ? `?reason=${auth.reason}` : ''
      return redirectWithCookies(`/login${reason}`, setCookies)
    }
    return isAuthPath(req.pathname) ? redirectWithCookies('/dashboard', setCookies) : null
  }

  const appHandle: Handle = async ({ event, resolve }) => {
    const forwardedSetCookies: string[] = []
    const pathname = event.url.pathname
    const req: ProtectedRequest = { pathname, routeId: event.route?.id ?? null }
    // Story 68-27: PV's own API proxy routes are authenticated by the API itself; resolving the
    // session here would only duplicate the call. `locals.user` stays null so nothing downstream
    // mistakes the absence of a probe for an identity.
    if (isBackendAuthenticatedRoute(req.routeId)) {
      event.locals.user = null
      return resolve(event)
    }

    const apiFetch = createServerApiFetch({ apiBaseUrl: apiBaseUrl() })

    const vaultRedirect = await redirectIfVaultUnavailable(apiFetch, req)
    if (vaultRedirect) return vaultRedirect

    const cookieHeader = event.request.headers.get('cookie')
    const auth = await resolveAuthContext({
      fetchFn: apiFetch,
      cookieHeader,
      forwardSetCookie: (value) => forwardedSetCookies.push(value),
    })

    // Always overwritten from the API's answer, so a contributed `before` handle that sets
    // `locals.user` cannot satisfy this gate (AC-7 spoofed-user test).
    event.locals.user = auth.status === 'authenticated' ? auth.user : null

    const gate = gateForAuth(auth, req, event.request, forwardedSetCookies)
    if (gate) return gate

    return appendSetCookies(await resolve(event), forwardedSetCookies)
  }

  /**
   * Story 15.1 AC 2/7 — resolves the SSR-visible locale from the `PARAGLIDE_LOCALE` cookie (cookie
   * strategy, see vite.config.ts's paraglideVitePlugin `strategy: ['cookie', 'baseLocale']`), and
   * substitutes `%paraglide.lang%` in app.html's `<html lang="...">`. An invalid/stale/tampered
   * cookie value is not a crash: Paraglide's own `toLocale()` validation rejects any value outside
   * the compiled locale set and the strategy chain falls through to `baseLocale` ('en').
   *
   * Story 68.6: composed with `composeHandles` (not Kit's `sequence()`), so a hand-built fake event
   * still works in unit tests (`sequence()` needs Kit's per-request AsyncLocalStorage). Contributed
   * `after` handles run inside this callback, so they see the request's locale (Q10).
   */
  return ({ event, resolve }) =>
    paraglideMiddleware(event.request, ({ request, locale }) => {
      event.request = request
      return appHandle({
        event,
        resolve: (ev, opts) =>
          resolve(ev, {
            ...opts,
            transformPageChunk: async (chunk) => {
              const html = (await opts?.transformPageChunk?.(chunk)) ?? chunk.html
              return html.replace('%paraglide.lang%', locale)
            },
          }),
      })
    })
}
