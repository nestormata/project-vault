import type { SecureRouteContext } from '../../lib/secure-route.js'
import type { OrgRole } from '../../plugins/require-org-role.js'
import { getProjectMembershipRole } from './member-management.js'

function isOrgAdminOrOwner(orgRole: OrgRole): boolean {
  return orgRole === 'owner' || orgRole === 'admin'
}

/**
 * Story 4.5 D1/AC-V1: a caller can see a project if their org role is owner/admin (unconditional
 * bypass), or they hold any `project_memberships` row for that project.
 */
export async function callerCanSeeProject(
  secureCtx: SecureRouteContext,
  projectId: string
): Promise<boolean> {
  if (isOrgAdminOrOwner(secureCtx.auth.orgRole)) return true
  const role = await getProjectMembershipRole(secureCtx.tx, {
    orgId: secureCtx.auth.orgId,
    projectId,
    userId: secureCtx.auth.userId,
  })
  return role !== undefined
}

/**
 * Story 4.5 D4/AC-P1: effective role for value-reveal / version-create gates.
 * Org owner/admin always use their org role; otherwise project role if present, else org role.
 */
export async function effectiveProjectRole(
  secureCtx: SecureRouteContext,
  projectId: string
): Promise<OrgRole> {
  if (isOrgAdminOrOwner(secureCtx.auth.orgRole)) return secureCtx.auth.orgRole
  const projectRole = await getProjectMembershipRole(secureCtx.tx, {
    orgId: secureCtx.auth.orgId,
    projectId,
    userId: secureCtx.auth.userId,
  })
  return (projectRole as OrgRole | undefined) ?? secureCtx.auth.orgRole
}

/** Structured denial log for the new visibility gate (AC-V10). */
export function logVisibilityDenied(
  req: { log: { warn: (payload: Record<string, unknown>, msg?: string) => void } },
  input: { projectId: string; callerId: string; orgRole: OrgRole }
): void {
  req.log.warn(
    {
      eventType: 'project.visibility_denied',
      projectId: input.projectId,
      callerId: input.callerId,
      orgRole: input.orgRole,
    },
    'Project visibility denied'
  )
}
