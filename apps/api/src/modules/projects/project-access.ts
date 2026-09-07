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
 * Story 4.5 D4/AC-P1, story 37.1 AC2.2: the shared bypass + fallback DECISION at the heart of
 * "effective project role" — org owner/admin always use their own org role unconditionally
 * (the bypass never consults any `project_memberships` row); otherwise the explicit project role
 * if one was found, else the org role.
 *
 * Deliberately takes the already-resolved `orgRole`/`membershipRole` as primitives rather than a
 * `SecureRouteContext` or a `tx`, and deliberately does NOT query `project_memberships` itself —
 * callers each fetch that row via whatever query shape their own cross-tenant-safety invariants
 * require (this module's `effectiveProjectRole()` via a standalone `getProjectMembershipRole()`
 * call; `project-authorization.ts`'s hook via a single `projects LEFT JOIN project_memberships`
 * query that must stay the ONLY query on that path — see that module's AC3.2 doc comment). This
 * keeps the genuinely-identical bypass+fallback logic shared in one place without forcing a
 * second DB round-trip on either caller.
 */
export function resolveEffectiveProjectRoleForOrgRole(input: {
  orgRole: OrgRole
  membershipRole: OrgRole | undefined
}): OrgRole {
  if (isOrgAdminOrOwner(input.orgRole)) return input.orgRole
  return input.membershipRole ?? input.orgRole
}

/**
 * Story 4.5 D4/AC-P1: effective role for value-reveal / version-create gates.
 * Org owner/admin always use their org role; otherwise project role if present, else org role.
 */
export async function effectiveProjectRole(
  secureCtx: SecureRouteContext,
  projectId: string
): Promise<OrgRole> {
  // Short-circuit: org owner/admin never needs the `project_memberships` row at all — skip the
  // query entirely rather than fetching a row `resolveEffectiveProjectRoleForOrgRole()` would
  // discard anyway.
  if (isOrgAdminOrOwner(secureCtx.auth.orgRole)) return secureCtx.auth.orgRole
  const projectRole = await getProjectMembershipRole(secureCtx.tx, {
    orgId: secureCtx.auth.orgId,
    projectId,
    userId: secureCtx.auth.userId,
  })
  return resolveEffectiveProjectRoleForOrgRole({
    orgRole: secureCtx.auth.orgRole,
    membershipRole: projectRole as OrgRole | undefined,
  })
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

/**
 * Story 4.5 AC-V3/AC-V10, 12-1 AC-1: shared membership-visibility gate for any route that must
 * check visibility before reading a project (dashboard, overview). Logs and returns `false` on
 * denial so the caller can 404 without leaking whether the project exists.
 */
export async function requireProjectVisible(
  secureCtx: SecureRouteContext,
  req: { log: { warn: (payload: Record<string, unknown>, msg?: string) => void } },
  projectId: string
): Promise<boolean> {
  if (await callerCanSeeProject(secureCtx, projectId)) return true
  logVisibilityDenied(req, {
    projectId,
    callerId: secureCtx.auth.userId,
    orgRole: secureCtx.auth.orgRole,
  })
  return false
}
