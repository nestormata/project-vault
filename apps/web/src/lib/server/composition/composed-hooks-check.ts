// Code review 68-6 (AC-6 Elicitation 3, Q3) — every module-init composition of the three hook
// contribution modules, run the way the hooks files run them at start-up: the server hooks (header
// policy, `handle` shape and `wrap`, every chain hook), the protected paths (redirect loop), the
// universal and client hooks. A failure throws the same message the server would print; otherwise
// it returns the header-policy delta as informational notes (recorded, never refused).
import type { Handle } from '@sveltejs/kit'
import { composeClientHooks } from '$lib/composition/compose-client-hooks.js'
import { composeUniversalHooks } from '$lib/composition/compose-universal-hooks.js'
import {
  PV_HEADER_POLICY,
  describeHeaderPolicyDelta,
  headerPolicyDeltaNotes,
} from '$lib/security/header-policy.js'
import {
  PV_PROTECTED_PREFIXES,
  composeProtectedPaths,
  type ContributedProtectedPaths,
} from '$lib/server/protected-paths.js'
import { composeServerHooks } from './compose-server-hooks.js'

export interface ContributionModules {
  server: Readonly<Record<string, unknown>>
  protectedPaths: ContributedProtectedPaths
  universal: Readonly<Record<string, unknown>>
  client: Readonly<Record<string, unknown>>
}

/** Stands in for PV's handle: only the composition's shape checks matter here. */
const passthrough: Handle = ({ event, resolve }) => resolve(event)

export function checkComposedHooks(modules: ContributionModules): { notes: string[] } {
  const server = composeServerHooks({ handle: passthrough }, modules.server, {
    headerPolicy: PV_HEADER_POLICY,
  })
  composeProtectedPaths(PV_PROTECTED_PREFIXES, modules.protectedPaths)
  composeUniversalHooks({}, modules.universal)
  composeClientHooks({}, modules.client)
  return {
    notes: headerPolicyDeltaNotes(describeHeaderPolicyDelta(PV_HEADER_POLICY, server.headerPolicy)),
  }
}
