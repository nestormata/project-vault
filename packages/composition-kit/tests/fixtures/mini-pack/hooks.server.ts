import type { Handle } from '@sveltejs/kit'
import { formatPlan } from './src/lib/cm-format.js'

// A CM server hook contribution (Story 68-6): a `before` handle that runs outermost (even for
// requests PV redirects), and a header-policy delta. `hookLabel` is not a hook: the composer notes
// it and PV's composition ignores it. The marker must reach the server bundle only (AC-1).
export const hookLabel = formatPlan('hook')

const SERVER_MARKER = 'PV_HOOKS_SERVER_MARKER_6c1f0a'

const stampRequest: Handle = async ({ event, resolve }) => {
  const response = await resolve(event)
  response.headers.set('x-cm-before', SERVER_MARKER)
  return response
}

export const handle = { before: [stampRequest] }

export const headerPolicy = (pv: {
  defaults: Readonly<Record<string, string>>
  rules: readonly unknown[]
  routeSetHeaders: readonly unknown[]
}) => ({ ...pv, defaults: { ...pv.defaults, 'x-cm-policy': 'on' } })
