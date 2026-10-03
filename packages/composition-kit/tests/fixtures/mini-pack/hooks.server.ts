import type { Handle, HandleFetch, HandleServerError, ServerInit } from '@sveltejs/kit'
import { env } from '$env/dynamic/private'
import { formatPlan } from './src/lib/cm-format.js'

// A CM server hook contribution (Story 68-6). `hookLabel` is not a hook: the composer notes it and
// PV's composition ignores it. The marker must reach the server bundle only (AC-1). The fixture API
// stub counts the calls below so the integration job can assert they ran (AC-13).
export const hookLabel = formatPlan('hook')

const SERVER_MARKER = 'PV_HOOKS_SERVER_MARKER_6c1f0a'

const count = (name: string) => fetch(`${env.API_BASE_URL}/__fixture/count/${name}`)

// `before` runs outermost, so it also stamps the responses PV's handle redirects.
const stampRequest: Handle = async ({ event, resolve }) => {
  const response = await resolve(event)
  response.headers.set('x-cm-before', SERVER_MARKER)
  return response
}

// `after` runs inside PV, after its redirects. `/cm-proxy` answers with a proxied `fetch()` Response,
// whose headers are immutable: PV must still forward refreshed cookies onto it (code review 68-6).
const proxy: Handle = ({ event, resolve }) =>
  event.url.pathname === '/cm-proxy'
    ? fetch(`${env.API_BASE_URL}/__fixture/proxied`)
    : resolve(event)

export const handle = { before: [stampRequest], after: [proxy] }

// Every server-side fetch a load makes carries a CM header (AC-2 handleFetch example).
export const handleFetch: HandleFetch = ({ request, fetch }) => {
  const headers = new Headers(request.headers)
  headers.set('x-cm-fetch', '1')
  return fetch(new Request(request, { headers }))
}

export const init: ServerInit = async () => {
  await count('server-init')
}

// Q7: once CM contributes handleError, SvelteKit's default logging no longer runs (by design).
export const handleError: HandleServerError = async ({ status }) => {
  await count(`handle-error-${status}`)
  return { message: 'Handled by the CM fixture' }
}

interface Policy {
  defaults: Readonly<Record<string, string>>
  rules: readonly unknown[]
  routeSetHeaders: readonly unknown[]
}

export const headerPolicy = (pv: Policy): Policy => {
  const defaults = { ...pv.defaults, 'x-cm-policy': 'on' }
  return {
    ...pv,
    defaults,
    rules: [
      ...pv.rules,
      {
        id: 'cm-billing',
        match: { routeId: '/(app)/cm-area' },
        headers: { ...defaults, 'permissions-policy': 'payment=(self)' },
      },
    ],
  }
}
