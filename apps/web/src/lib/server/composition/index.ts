// Story 68.6 AC-11 — the server-side composition pieces a full override of `src/hooks.server.ts`
// can import to rebuild PV's pipeline around its own code.
export { composeHandles, headerRequestOf, type ComposeHandlesOptions } from './compose-handles.js'
export {
  composeServerHooks,
  type ComposeServerHooksOptions,
  type ComposedServerHooks,
  type PvServerHooks,
} from './compose-server-hooks.js'
export { createPvHandle, type PvHandleOptions } from './pv-server-hooks.js'
export {
  EMPTY_CONTRIBUTED_PATHS,
  GUARD_REDIRECT_TARGETS,
  PV_PROTECTED_PREFIXES,
  composeProtectedPaths,
  isProtectedRequest,
  type ContributedProtectedPaths,
  type ProtectedPaths,
  type ProtectedRequest,
} from '$lib/server/protected-paths.js'
export { PV_HEADER_POLICY } from '$lib/security/header-policy.js'
