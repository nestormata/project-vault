import type {
  OrgAuthorizationCheckContext,
  OrgAuthorizationOutcome,
} from '@project-vault/extension-api'
import { resolveActiveOrgRole } from '../plugins/authenticate.js'
import type { OrgRole } from '../plugins/require-org-role.js'
import { roleRank } from './secure-route.js'

const RECOGNIZED_MINIMUM_ROLES = new Set<string>(['owner', 'admin', 'member', 'viewer'])

function isRecognizedOrgRole(value: string): value is OrgRole {
  return RECOGNIZED_MINIMUM_ROLES.has(value)
}

// AC4: bounded, never leaks raw internal detail (same MAX_REASON_CODE_LENGTH-style convention
// established elsewhere at this extension boundary, e.g. audit-event-source.ts).
const MAX_REASON_CODE_LENGTH = 200

/**
 * Story 23.9 — `HostServices.orgAuthorization.checkMembership()`'s real implementation, bound to
 * the loading extension by `loader.ts`'s `buildHostServices()`. Reuses
 * `authenticate.ts`'s `resolveActiveOrgRole()` for membership lookup (Task 1) and
 * `secure-route.ts`'s `roleRank()` for the "at least this role" comparison (AC2) — no new
 * authorization logic is written here.
 *
 * Never throws (AC4) and never caches/memoizes across calls (AC5) — every call re-runs Task 1's
 * resolution fresh.
 */
export async function checkOrgAuthorization(
  context: OrgAuthorizationCheckContext
): Promise<OrgAuthorizationOutcome> {
  // AC7: an out-of-enum minimumRole must be rejected before it ever reaches roleRank()'s
  // exhaustive switch (which has no default case and would otherwise mis-compare or throw).
  if (!isRecognizedOrgRole(context.minimumRole)) {
    return { outcome: 'error', reasonCode: 'invalid-minimum-role' }
  }

  let role: OrgRole | null
  try {
    role = await resolveActiveOrgRole(context.viewerIdentityId, context.organizationId)
  } catch (error) {
    // AC4: a genuine internal failure (e.g. a DB error during resolution) maps to 'error', never
    // an escaping exception. reasonCode is diagnostic-only, not a stable contract.
    const message = error instanceof Error ? error.message : 'resolution-failed'
    return { outcome: 'error', reasonCode: message.slice(0, MAX_REASON_CODE_LENGTH) }
  }

  // AC3: no row at all, or a row that exists but is not status: 'active', both surface from
  // resolveActiveOrgRole() as the same plain `null` — an expected "not currently a qualifying
  // member" case, not a system fault.
  if (!role) {
    return { outcome: 'denied', reasonCode: 'not-a-member' }
  }

  if (roleRank(role) < roleRank(context.minimumRole)) {
    return { outcome: 'denied', reasonCode: 'insufficient-role' }
  }

  return { outcome: 'authorized' }
}
