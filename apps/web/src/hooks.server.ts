import type { Handle } from '@sveltejs/kit'
import { env } from '$env/dynamic/private'
import { isAuthPath, isProtectedAppPath, resolveAuthContext } from '$lib/server/auth-guard.js'
import { getVaultReadiness } from '$lib/api/vault.js'
import {
  getExtensionPanelCspHeaders,
  getFrameProtectionHeaders,
  getHandoffSecurityHeaders,
  isHandoffPath,
} from '$lib/security/hardening.js'
import { createServerApiFetch } from '$lib/server/server-api-fetch.js'
import { paraglideMiddleware } from '$lib/paraglide/server.js'
import { parseAllowedOrigins } from '$lib/server/handoff-cors.js'

// A plain index-signature record (matching $env/dynamic/private's own shape) rather than a
// closed object type — a closed all-optional type here trips TypeScript's "weak type" check
// against env's actual type (which carries many other known keys), since the two would then
// share no declared property in common.
type HandoffCorsBootEnv = Record<string, string | undefined>

// AC4 (Story 60.1) — Design Decision 2: apps/web has no createApp()-style boot sequence or
// structured operationalLog/OperationalEvent machinery (unlike apps/api's
// handoff-boot.ts::resolveHandoffAuthStrategy()), so this is a small, independently unit-testable
// pure function instead of a port of that pattern. It must never throw and must stay silent
// unless the real misconfiguration holds: called from this module's top level (see below), it
// re-executes on every test-file import of this module and on every dev-server/build module load,
// not only once per real server process start.
export function checkHandoffCorsBootWarning(rawEnv: HandoffCorsBootEnv): void {
  if (rawEnv.VAULT_HANDOFF_ENABLED !== 'true') return

  const allowedOrigins = parseAllowedOrigins(rawEnv.CORS_ALLOWED_ORIGINS)
  const pvOrigin = rawEnv.ORIGIN ?? ''
  const hasNonPvOrigin = [...allowedOrigins].some((origin) => origin !== pvOrigin)
  if (hasNonPvOrigin) return

  // eslint-disable-next-line no-console -- intentional operator-facing boot diagnostic (AC4), not app logging
  console.warn(
    '[handoff] WARN: VAULT_HANDOFF_ENABLED is true but CORS_ALLOWED_ORIGINS contains no ' +
      "non-PV origin — CentralizeMe's cross-origin handoff prepare call will be rejected. " +
      "Under Docker Compose, add CentralizeMe's origin with CORS_EXTRA_ORIGINS (the env-file " +
      'CORS_ALLOWED_ORIGINS is ignored there). See docs/configuration.md # Handoff & service integration.'
  )
}

// Module-scope call: SvelteKit/adapter-node runs module-scope code once per server process start,
// giving the same "boot time" semantics as apps/api's boot hook without inventing one here (see
// checkHandoffCorsBootWarning's own doc comment for why this must be side-effect-free by default).
checkHandoffCorsBootWarning(env)

function appendSetCookies(response: Response, setCookies: string[]) {
  for (const setCookie of setCookies) response.headers.append('set-cookie', setCookie)
  return response
}

function redirectWithCookies(location: string, setCookies: string[]) {
  return appendSetCookies(new Response(null, { status: 303, headers: { location } }), setCookies)
}

// Story 29.1 — code-review hardening (2026-08-29). The extension-panel route renders sanitized,
// but not network-egress-restricted, third-party HTML inline into this same document/session
// (see `hardening.ts`'s `getExtensionPanelCspHeaders` doc comment for the full rationale) — a
// tighter, route-scoped CSP replaces the `<meta>`-based one the now-deleted `srcdoc` iframe used
// to carry. `event.setHeaders` throws on a duplicate header name, so this must be exclusive with
// the general `getFrameProtectionHeaders()` call below, not additive to it.
function isExtensionPanelPath(pathname: string) {
  return pathname.startsWith('/extensions/panels/')
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

function securityHeadersFor(pathname: string) {
  // Story 60.3 AC4: `event.setHeaders` throws on a duplicate header name, so the handoff branch
  // must supply the FULL header set for that route in one call (its own frame-protection headers
  // plus Referrer-Policy) — never call this alongside a second header-getter for the same route.
  if (isHandoffPath(pathname)) return getHandoffSecurityHeaders()
  if (isExtensionPanelPath(pathname)) return getExtensionPanelCspHeaders()
  return getFrameProtectionHeaders()
}

const appHandle: Handle = async ({ event, resolve }) => {
  event.setHeaders(securityHeadersFor(event.url.pathname))
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
