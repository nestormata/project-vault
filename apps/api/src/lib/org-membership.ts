import type { OrgMembershipCheck, OrgMembershipResult } from '@project-vault/extension-api'
import { resolveActiveOrgRole } from '../plugins/authenticate.js'

const UNAVAILABLE_REASON = 'membership_check_failed'

/**
 * Story 43.30 — the one membership lookup shared by the CLI organization exchange and
 * `HostServices.membership.isOrgMember`. No ambient request. `userId` is `users.id`.
 * A query that finds no active membership is `denied`. Any throw (invalid id, database
 * failure, host failure) is `unavailable` and is never turned into `denied`.
 */
export async function isOrgMember(check: OrgMembershipCheck): Promise<OrgMembershipResult> {
  try {
    const role = await resolveActiveOrgRole(check.userId, check.organizationId)
    return role ? { status: 'allowed' } : { status: 'denied' }
  } catch {
    return { status: 'unavailable', reason: UNAVAILABLE_REASON }
  }
}
