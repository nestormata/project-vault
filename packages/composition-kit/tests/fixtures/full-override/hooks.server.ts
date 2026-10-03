import { env } from '$env/dynamic/private'
import { hooks, protectedPaths } from 'virtual:pv-hooks/server'
import {
  PV_HEADER_POLICY,
  PV_PROTECTED_PREFIXES,
  composeProtectedPaths,
  composeServerHooks,
  createPvHandle,
} from '$lib/server/composition/index.js'

// Story 68-6 AC-11: a full-file override of src/hooks.server.ts (M1) that rebuilds PV's pipeline
// from PV's importable pieces, keeps the derived protection, adds its own default header and opts
// back in to the pack's `handle` contribution explicitly.
const composed = composeServerHooks(
  {
    handle: createPvHandle({
      apiBaseUrl: () => env.API_BASE_URL,
      protectedPaths: composeProtectedPaths(PV_PROTECTED_PREFIXES, protectedPaths),
    }),
  },
  { handle: hooks.handle },
  {
    headerPolicy: {
      ...PV_HEADER_POLICY,
      defaults: { ...PV_HEADER_POLICY.defaults, 'x-cm-override': 'full' },
    },
  }
)

export const handle = composed.handle
