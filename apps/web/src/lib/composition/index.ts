// Story 68.6 AC-11 — the client-safe composition pieces a full override of `src/hooks.ts` or
// `src/hooks.client.ts` can import to rebuild PV's composition around its own code.
export { composeChainHook, readHandleContribution, type HookFile } from './hook-chain.js'
export { composeUniversalHooks, type UniversalHooks } from './compose-universal-hooks.js'
export { composeClientHooks, type ClientHooks } from './compose-client-hooks.js'
export { HOOK_SURFACE, SERVER_CONTRIBUTION_EXPORTS } from './hook-surface.js'
export { stripRouteGroups } from './route-id.js'
export {
  PV_HEADER_POLICY,
  composeHeaderPolicy,
  describeHeaderPolicyDelta,
  resolveHeaders,
  validateHeaderPolicy,
  type HeaderMatch,
  type HeaderPolicy,
  type HeaderPolicyContribution,
  type HeaderPolicyDelta,
  type HeaderRequest,
  type HeaderRule,
  type RouteSetHeaders,
} from '$lib/security/header-policy.js'
