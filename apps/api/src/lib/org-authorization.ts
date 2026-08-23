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

// AC4: reasonCode on the 'error' outcome must never leak raw internal detail (e.g. driver/DB
// error text, or withOrg()'s own "invalid orgId, received: ..." message) to extension code —
// only a fixed, generic diagnostic string. Code review finding (2026-08-22): the original
// implementation truncated `error.message` to this length but still echoed its *content*
// verbatim, contradicting this comment's own stated intent.
const INTERNAL_ERROR_REASON_CODE = 'resolution-failed'

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
  } catch {
    // AC4: a genuine internal failure (e.g. a DB error during resolution) maps to 'error', never
    // an escaping exception. reasonCode is a fixed, generic diagnostic string — never the raw
    // caught error's message (that would leak internal detail, e.g. withOrg()'s own
    // "invalid orgId, received: ..." text, to extension code across a trust boundary).
    return { outcome: 'error', reasonCode: INTERNAL_ERROR_REASON_CODE }
  }

  // AC3: no row at all, or a row that exists but is not status: 'active', both surface from
  // resolveActiveOrgRole() as the same plain `null` — an expected "not currently a qualifying
  // member" case, not a system fault.
  if (!role) {
    return { outcome: 'denied', reasonCode: 'not-a-member' }
  }

  if (roleRank(role) < roleRank(context.minimumRole)) {
    // Code review finding (2026-08-22): deliberately reuses AC3's 'not-a-member' reasonCode
    // rather than a distinct 'insufficient-role' string. reasonCode is documented as
    // diagnostic-only, not a stable contract (see Dev Notes), and no AC pins a distinct value for
    // this branch — but a distinct value here would let a caller distinguish "no active
    // membership at all" from "active member, role too low" purely by reading reasonCode, which
    // is a membership-existence oracle for an (organizationId, viewerIdentityId) pair the caller
    // may have no legitimate relationship to. Both denial paths are collapsed to the same
    // reasonCode so only the boolean authorized/denied signal is observable, never which reason.
    return { outcome: 'denied', reasonCode: 'not-a-member' }
  }

  return { outcome: 'authorized' }
}
