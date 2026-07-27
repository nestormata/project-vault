import type { Handle } from '@sveltejs/kit'
import { env } from '$env/dynamic/private'
import { isAuthPath, isProtectedAppPath, resolveAuthContext } from '$lib/server/auth-guard.js'
import { getVaultReadiness } from '$lib/api/vault.js'
import { getFrameProtectionHeaders } from '$lib/security/hardening.js'
import { createServerApiFetch } from '$lib/server/server-api-fetch.js'
import { paraglideMiddleware } from '$lib/paraglide/server.js'

function appendSetCookies(response: Response, setCookies: string[]) {
  for (const setCookie of setCookies) response.headers.append('set-cookie', setCookie)
  return response
}

function redirectWithCookies(location: string, setCookies: string[]) {
  return appendSetCookies(new Response(null, { status: 303, headers: { location } }), setCookies)
}

function shouldCheckVaultReadiness(pathname: string) {
  return (
    pathname !== '/vault' &&
    (['/', '/login', '/register'].includes(pathname) || isProtectedAppPath(pathname))
  )
}

async function redirectIfVaultUnavailable(fetchFn: typeof fetch, pathname: string) {
  if (!shouldCheckVaultReadiness(pathname)) return null
  const readiness = await getVaultReadiness(fetchFn)
  return readiness.state === 'ready'
    ? null
    : new Response(null, { status: 303, headers: { location: '/vault' } })
}

const appHandle: Handle = async ({ event, resolve }) => {
  event.setHeaders(getFrameProtectionHeaders())
  const forwardedSetCookies: string[] = []
  const pathname = event.url.pathname
  const apiFetch = createServerApiFetch({ apiBaseUrl: env.API_BASE_URL })

  const vaultRedirect = await redirectIfVaultUnavailable(apiFetch, pathname)
  if (vaultRedirect) return vaultRedirect

  const cookieHeader = event.request.headers.get('cookie')
  const auth = await resolveAuthContext({
    fetchFn: apiFetch,
    cookieHeader,
    forwardSetCookie: (value) => forwardedSetCookies.push(value),
  })

  event.locals.user = auth.status === 'authenticated' ? auth.user : null

  if (isProtectedAppPath(pathname) && auth.status !== 'authenticated') {
    const reason = auth.reason ? `?reason=${auth.reason}` : ''
    return redirectWithCookies(`/login${reason}`, forwardedSetCookies)
  }

  if (isAuthPath(pathname) && auth.status === 'authenticated') {
    return redirectWithCookies('/dashboard', forwardedSetCookies)
  }

  return appendSetCookies(await resolve(event), forwardedSetCookies)
}

/**
 * Story 15.1 AC 2/7 — resolves the SSR-visible locale from the `PARAGLIDE_LOCALE` cookie (cookie
 * strategy, see vite.config.ts's paraglideVitePlugin `strategy: ['cookie', 'baseLocale']`), and
 * substitutes `%paraglide.lang%` in app.html's `<html lang="...">`. An invalid/stale/tampered
 * cookie value is not a crash: Paraglide's own `toLocale()` validation rejects any value outside
 * the compiled locale set and the strategy chain falls through to `baseLocale` ('en') — this is
 * relied upon rather than hand-rolled (AC 7 edge case), matching Task 5.4's guidance.
 *
 * Composed manually (rather than via `sequence()` from `@sveltejs/kit/hooks`) so this file's own
 * unit tests can keep invoking `handle({ event, resolve })` directly with a hand-built fake event
 * — `sequence()` internally requires SvelteKit's real per-request AsyncLocalStorage context
 * (`get_request_store()`), which only exists inside an actual SvelteKit request lifecycle, not a
 * fabricated test event.
 */
export const handle: Handle = ({ event, resolve }) =>
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
