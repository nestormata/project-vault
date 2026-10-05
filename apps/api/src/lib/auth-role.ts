import type { OrgRole } from '../plugins/require-org-role.js'
import { AppError } from './errors.js'

/**
 * Story 71.3: `AuthContext.orgRole` is optional because a service-delegated actor that is not a
 * verified member (an unlinked actor) has no PV role. A session always has one, so on every
 * session route this is a no-op; if a roleless context ever reaches a reader of the role, the
 * answer is a 403, never a default role (no role = no access).
 */
export function orgRoleOrDeny(auth: { orgRole?: OrgRole }): OrgRole {
  if (auth.orgRole === undefined) {
    throw new AppError('insufficient_role', 'Insufficient permissions', 403)
  }
  return auth.orgRole
}
