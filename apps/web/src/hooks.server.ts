import { redirect, type Handle } from '@sveltejs/kit'
import { isAuthPath, isProtectedAppPath, resolveAuthContext } from '$lib/server/auth-guard.js'
import { getFrameProtectionHeaders } from '$lib/security/hardening.js'

export const handle: Handle = async ({ event, resolve }) => {
  event.setHeaders(getFrameProtectionHeaders())

  const cookieHeader = event.request.headers.get('cookie')
  const auth = await resolveAuthContext({
    fetchFn: event.fetch,
    cookieHeader,
    forwardSetCookie: (value) => {
      // SvelteKit same-origin fetch forwards cookies automatically; this preserves API Set-Cookie
      // when the backend is reached through the configured server-side boundary.
      event.setHeaders({ 'set-cookie': value })
    },
  })

  event.locals.user = auth.status === 'authenticated' ? auth.user : null

  if (isProtectedAppPath(event.url.pathname) && auth.status !== 'authenticated') {
    const reason = auth.reason ? `?reason=${auth.reason}` : ''
    throw redirect(303, `/login${reason}`)
  }

  if (isAuthPath(event.url.pathname) && auth.status === 'authenticated') {
    throw redirect(303, '/dashboard')
  }

  return resolve(event)
}
