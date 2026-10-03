import type { Handle } from '@sveltejs/kit'
import { env } from '$env/dynamic/private'
import { protectedPaths } from 'virtual:pv-hooks/server'
import {
  PV_HEADER_POLICY,
  PV_PROTECTED_PREFIXES,
  composeProtectedPaths,
  composeServerHooks,
  createPvHandle,
} from '$lib/server/composition/index.js'

// M1 (e): a FULL `src/hooks.server.ts` override that rebuilds PV's pipeline from PV's importable
// pieces (the shape of design section 4), keeps the derived protection and adds one handle that
// stamps every response, plus one default response header.
const stamp: Handle = async ({ event, resolve }) => {
  const response = await resolve(event)
  response.headers.set('x-mock-ui-pack-handle', 'm1-hooks-handle')
  return response
}

const composed = composeServerHooks(
  {
    handle: createPvHandle({
      apiBaseUrl: () => env.API_BASE_URL,
      protectedPaths: composeProtectedPaths(PV_PROTECTED_PREFIXES, protectedPaths),
    }),
  },
  { handle: { before: [stamp] } },
  {
    headerPolicy: {
      ...PV_HEADER_POLICY,
      defaults: { ...PV_HEADER_POLICY.defaults, 'x-mock-ui-pack-policy': 'm1-hooks-policy' },
    },
  }
)

export const handle = composed.handle
