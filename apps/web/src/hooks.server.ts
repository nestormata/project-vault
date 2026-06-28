import type { Handle } from '@sveltejs/kit'
import { isAuthPath, isProtectedAppPath, resolveAuthContext } from '$lib/server/auth-guard.js'
import { getVaultReadiness } from '$lib/api/vault.js'
import { getFrameProtectionHeaders } from '$lib/security/hardening.js'

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

export const handle: Handle = async ({ event, resolve }) => {
  event.setHeaders(getFrameProtectionHeaders())
  const forwardedSetCookies: string[] = []
  const pathname = event.url.pathname

  const vaultRedirect = await redirectIfVaultUnavailable(event.fetch, pathname)
  if (vaultRedirect) return vaultRedirect

  const cookieHeader = event.request.headers.get('cookie')
  const auth = await resolveAuthContext({
    fetchFn: event.fetch,
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
