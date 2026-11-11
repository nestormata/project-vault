import { and, eq, sql } from 'drizzle-orm'
import { getDb, type Tx } from '@project-vault/db'
import { orgMemberships, projectMemberships, projects } from '@project-vault/db/schema'
import { AuditEvent } from '@project-vault/shared'
import { AppError } from '../../lib/errors.js'
import { writeSystemAuditEntry } from '../audit/machine-entry.js'
import { writeUnrecognizedRoleSecurityEvent } from '../auth/unrecognized-role-security-events.js'
import {
  lockOrgMembershipForUpdate,
  orgOwnersForUpdate,
  removeUserFromOrgMemberships,
  soleOwnerProjectsForUpdate,
} from '../org/user-management.js'
import {
  addExistingOrgUserToProject,
  lockProjectMembershipForUpdate,
  projectOwnersForUpdate,
  removeProjectMembership,
  type AddMemberRole,
} from '../projects/member-management.js'
import { PROJECT_ARCHIVED_ERROR } from '../projects/archive-guards.js'
import {
  organizationNotCentralizemeManagedError,
  selectOrgForCentralizemeLink,
  SERVICE_ORG_MEMBER_ROLES,
  type ServiceOrgMemberRole,
} from './service.js'

export class SoleOwnerOfProjectsError extends AppError {
  constructor(public readonly projects: { projectId: string; projectName: string }[]) {
    super(
      'sole_owner_of_projects',
      'Transfer ownership of these projects before removing this user',
      409
    )
  }
}

export function unrecognizedRequestedRoleError(): AppError {
  return new AppError('invalid_role', 'Role is not recognized', 400)
}

export function userNotFoundError(): AppError {
  return new AppError('user_not_found', 'User not found in this organization', 404)
}

export function membershipNotFoundError(): AppError {
  return new AppError('membership_not_found', 'User is not a member of this project', 404)
}

export function projectNotFoundError(): AppError {
  return new AppError('project_not_found', 'Project not found', 404)
}

export function lastOrgOwnerError(): AppError {
  return new AppError('last_org_owner', 'Cannot remove the sole owner of the organization', 409)
}

export function lastProjectOwnerError(): AppError {
  return new AppError('last_owner', 'Cannot remove the last owner of a project', 409)
}

export function mustTransferOwnershipError(): AppError {
  return new AppError(
    'must_transfer_ownership_first',
    'Use transfer-ownership to change the project owner',
    409
  )
}

export function alreadyMemberError(): AppError {
  return new AppError('already_member', 'User is already a project member', 409)
}

export function projectArchivedError(): AppError {
  return new AppError(PROJECT_ARCHIVED_ERROR.code, PROJECT_ARCHIVED_ERROR.message, 410)
}

const GRANTABLE_ROLES = SERVICE_ORG_MEMBER_ROLES
type GrantableRole = ServiceOrgMemberRole

async function assertCentralizemeManagedOrg(tx: Tx, organizationId: string): Promise<void> {
  const org = await selectOrgForCentralizemeLink(tx, organizationId)
  if (org.centralizemeOrganizationId === null) throw organizationNotCentralizemeManagedError()
}

async function withOrgContext(tx: Tx, organizationId: string): Promise<void> {
  await tx.execute(sql`SELECT set_config('app.current_org_id', ${organizationId}, true)`)
}

async function inManagedOrg<T>(organizationId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return getDb().transaction(async (tx) => {
    const typedTx = tx as Tx
    await withOrgContext(typedTx, organizationId)
    await assertCentralizemeManagedOrg(typedTx, organizationId)
    return fn(typedTx)
  })
}

async function inManagedWritableProject<T>(
  organizationId: string,
  projectId: string,
  fn: (tx: Tx) => Promise<T>
): Promise<T> {
  return inManagedOrg(organizationId, async (tx) => {
    await loadWritableProject(tx, organizationId, projectId)
    return fn(tx)
  })
}

export async function rejectUnrecognizedRequestedRole(input: {
  role: string
  organizationId: string
  routeKey: string
  requestId: string
}): Promise<GrantableRole> {
  if (!(GRANTABLE_ROLES as readonly string[]).includes(input.role)) {
    await writeUnrecognizedRoleSecurityEvent({
      source: 'requested',
      role: input.role,
      orgId: input.organizationId,
      routeKey: input.routeKey,
      requestId: input.requestId,
    })
    throw unrecognizedRequestedRoleError()
  }
  return input.role as GrantableRole
}

async function lockActiveOrgMember(
  tx: Tx,
  organizationId: string,
  userId: string
): Promise<{ orgRole: string; otherOwnerCount: number }> {
  const owners = await orgOwnersForUpdate(tx, organizationId)
  const target = await lockOrgMembershipForUpdate(tx, organizationId, userId)
  if (!target || target.status !== 'active') throw userNotFoundError()
  return {
    orgRole: target.orgRole,
    otherOwnerCount: owners.filter((row) => row.userId !== userId).length,
  }
}

function assertNotLastOrgOwner(orgRole: string, otherOwnerCount: number): void {
  if (orgRole === 'owner' && otherOwnerCount === 0) throw lastOrgOwnerError()
}

export async function changeServiceOrgMemberRole(
  organizationId: string,
  userId: string,
  input: { requestId: string; role: string }
): Promise<{ userId: string; role: string }> {
  const role = await rejectUnrecognizedRequestedRole({
    role: input.role,
    organizationId,
    routeKey: 'PATCH /api/v1/service/organizations/:organizationId/members/:userId',
    requestId: input.requestId,
  })

  return inManagedOrg(organizationId, async (tx) => {
    const target = await lockActiveOrgMember(tx, organizationId, userId)

    if (target.orgRole === role) {
      return { userId, role }
    }

    assertNotLastOrgOwner(target.orgRole, target.otherOwnerCount)

    await tx
      .update(orgMemberships)
      .set({ role })
      .where(and(eq(orgMemberships.orgId, organizationId), eq(orgMemberships.userId, userId)))

    await writeSystemAuditEntry(tx, {
      orgId: organizationId,
      eventType: AuditEvent.ORG_MEMBER_ROLE_CHANGED,
      resourceId: userId,
      resourceType: 'org_membership',
      payload: {
        oldRole: target.orgRole,
        newRole: role,
        requestId: input.requestId,
      },
    })

    return { userId, role }
  })
}

export async function removeServiceOrgMember(
  organizationId: string,
  userId: string,
  input: { requestId: string }
): Promise<{ userId: string; removedProjectCount: number }> {
  return inManagedOrg(organizationId, async (tx) => {
    const target = await lockActiveOrgMember(tx, organizationId, userId)
    assertNotLastOrgOwner(target.orgRole, target.otherOwnerCount)

    const soleOwnerRows = await soleOwnerProjectsForUpdate(tx, organizationId, userId)
    if (soleOwnerRows.length > 0) throw new SoleOwnerOfProjectsError(soleOwnerRows)

    const { removedProjectCount } = await removeUserFromOrgMemberships(tx, organizationId, userId)

    await writeSystemAuditEntry(tx, {
      orgId: organizationId,
      eventType: AuditEvent.ORG_USER_REMOVED,
      resourceId: userId,
      resourceType: 'org_membership',
      payload: { removedProjectCount, requestId: input.requestId },
    })

    return { userId, removedProjectCount }
  })
}

async function loadWritableProject(
  tx: Tx,
  organizationId: string,
  projectId: string
): Promise<void> {
  const [project] = await tx
    .select({
      id: projects.id,
      archivedAt: projects.archivedAt,
      deletedAt: projects.deletedAt,
    })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.orgId, organizationId)))
    .limit(1)
    .for('share')
  if (!project || project.deletedAt !== null) throw projectNotFoundError()
  if (project.archivedAt !== null) throw projectArchivedError()
}

export async function addServiceProjectMember(
  organizationId: string,
  projectId: string,
  input: { requestId: string; userId: string; role: string }
): Promise<{ userId: string; email: string; displayName: string; role: string }> {
  const role = await rejectUnrecognizedRequestedRole({
    role: input.role,
    organizationId,
    routeKey: 'POST /api/v1/service/organizations/:organizationId/projects/:projectId/members',
    requestId: input.requestId,
  })

  return inManagedWritableProject(organizationId, projectId, async (tx) => {
    const result = await addExistingOrgUserToProject(tx, {
      orgId: organizationId,
      projectId,
      userId: input.userId,
      role: role as AddMemberRole,
      callerEffectiveRole: 'admin',
    })
    if (result.status === 'user_not_found') throw userNotFoundError()
    if (result.status === 'already_member') throw alreadyMemberError()
    if (result.status === 'role_above_caller') throw unrecognizedRequestedRoleError()

    await writeSystemAuditEntry(tx, {
      orgId: organizationId,
      eventType: AuditEvent.PROJECT_MEMBER_ADDED,
      resourceId: input.userId,
      resourceType: 'project_membership',
      payload: { projectId, role, requestId: input.requestId },
    })

    return result.member
  })
}

export async function changeServiceProjectMemberRole(
  organizationId: string,
  projectId: string,
  userId: string,
  input: { requestId: string; role: string }
): Promise<{ userId: string; projectId: string; role: string }> {
  const role = await rejectUnrecognizedRequestedRole({
    role: input.role,
    organizationId,
    routeKey:
      'PATCH /api/v1/service/organizations/:organizationId/projects/:projectId/members/:userId',
    requestId: input.requestId,
  })

  return inManagedWritableProject(organizationId, projectId, async (tx) => {
    await projectOwnersForUpdate(tx, projectId)
    const membershipRole = await lockProjectMembershipForUpdate(tx, {
      orgId: organizationId,
      projectId,
      userId,
    })
    if (!membershipRole) throw membershipNotFoundError()
    if (membershipRole === 'owner') throw mustTransferOwnershipError()
    if (membershipRole === role) {
      return { userId, projectId, role }
    }

    await tx
      .update(projectMemberships)
      .set({ role })
      .where(
        and(eq(projectMemberships.projectId, projectId), eq(projectMemberships.userId, userId))
      )

    await writeSystemAuditEntry(tx, {
      orgId: organizationId,
      eventType: AuditEvent.PROJECT_MEMBER_ROLE_CHANGED,
      resourceId: userId,
      resourceType: 'project_membership',
      payload: {
        projectId,
        oldRole: membershipRole,
        newRole: role,
        requestId: input.requestId,
      },
    })

    return { userId, projectId, role }
  })
}

export async function removeServiceProjectMember(
  organizationId: string,
  projectId: string,
  userId: string,
  input: { requestId: string }
): Promise<void> {
  return inManagedWritableProject(organizationId, projectId, async (tx) => {
    const owners = await projectOwnersForUpdate(tx, projectId)
    const membershipRole = await lockProjectMembershipForUpdate(tx, {
      orgId: organizationId,
      projectId,
      userId,
    })
    if (!membershipRole) throw membershipNotFoundError()

    if (membershipRole === 'owner') {
      const otherOwners = owners.filter((row) => row.userId !== userId)
      if (otherOwners.length === 0) throw lastProjectOwnerError()
    }

    await removeProjectMembership(tx, projectId, userId)

    await writeSystemAuditEntry(tx, {
      orgId: organizationId,
      eventType: AuditEvent.PROJECT_MEMBER_REMOVED,
      resourceId: userId,
      resourceType: 'project_membership',
      payload: { projectId, removedRole: membershipRole, requestId: input.requestId },
    })
  })
}
