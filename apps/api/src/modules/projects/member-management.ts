import { and, count, eq } from 'drizzle-orm'
import { type Tx } from '@project-vault/db'
import { orgMemberships, projectMemberships, users } from '@project-vault/db/schema'
import type { OrgRole } from '../../plugins/require-org-role.js'

/**
 * AC-5: remove a single user's membership from one project, inside the caller's transaction. Lives
 * here rather than inline in `routes.ts` so the route stays a thin `secureRoute` registration —
 * `route-audit.test.ts` scans `routes.ts` for bare `.delete(...)` calls its parser cannot tell
 * apart from raw Fastify route shorthands. Callers MUST run the authorization and last-owner guards
 * before invoking this — it deletes unconditionally.
 */
export async function removeProjectMembership(
  tx: Tx,
  projectId: string,
  userId: string
): Promise<void> {
  await tx
    .delete(projectMemberships)
    .where(and(eq(projectMemberships.projectId, projectId), eq(projectMemberships.userId, userId)))
}

/**
 * Look up a single user's role within a project, scoped to the org. Returns the role string, or
 * `undefined` when the user is not a member. Shared between org's project-role-change handler and
 * projects' member-removal handler so the identical `(projectId, userId, orgId)` lookup lives in
 * one place; each call site keeps its own 404 reply.
 */
export async function getProjectMembershipRole(
  tx: Tx,
  { orgId, projectId, userId }: { orgId: string; projectId: string; userId: string }
): Promise<string | undefined> {
  const [membership] = await tx
    .select({ role: projectMemberships.role })
    .from(projectMemberships)
    .where(
      and(
        eq(projectMemberships.projectId, projectId),
        eq(projectMemberships.userId, userId),
        eq(projectMemberships.orgId, orgId)
      )
    )
    .limit(1)
  return membership?.role
}

/**
 * 12-1 AC-2: the project overview's member-count summary tile. Deliberately a standalone COUNT
 * rather than reusing the GET /:projectId/members row list — that endpoint is
 * project-admin/owner-or-org-admin/owner-gated (callerCanManageMembers), while the overview page
 * must show a real count to every project role, including viewer (persona journey: Riley-viewer).
 */
export async function getProjectMemberCount(tx: Tx, projectId: string): Promise<number> {
  const [row] = await tx
    .select({ count: count() })
    .from(projectMemberships)
    .where(eq(projectMemberships.projectId, projectId))
  return Number(row?.count ?? 0)
}

// Least to most privileged. A local order (not `roleRank` from secure-route) because secure-route
// imports project-access, which imports this module.
const ROLE_ORDER: readonly string[] = ['viewer', 'member', 'admin', 'owner']

export type AddMemberRole = 'viewer' | 'member' | 'admin'

export type AddExistingMemberResult =
  | {
      status: 'added'
      member: { userId: string; email: string; displayName: string; role: string }
    }
  | { status: 'role_above_caller' }
  | { status: 'user_not_found' }
  | { status: 'already_member' }

// Postgres unique_violation: the (project_id, user_id) primary key lost a concurrent double add.
const UNIQUE_VIOLATION = '23505'

function isUniqueViolation(error: unknown): boolean {
  const pgError = error as { code?: string; cause?: { code?: string } } | null
  return pgError?.code === UNIQUE_VIOLATION || pgError?.cause?.code === UNIQUE_VIOLATION
}

/**
 * Story 72-14: add an EXISTING active user of the caller's org to a project. Callers MUST have run
 * the project-exists/archived checks and the manage-members authorization first. The target is
 * looked up through `org_memberships` (RLS-scoped to the ambient org, `status = 'active'`), so a
 * cross-org, deactivated or nonexistent id all answer `user_not_found`. The insert runs in a
 * savepoint so a concurrent-add primary-key conflict maps to `already_member` without aborting the
 * caller's transaction.
 */
export async function addExistingOrgUserToProject(
  tx: Tx,
  input: {
    orgId: string
    projectId: string
    userId: string
    role: AddMemberRole
    callerEffectiveRole: OrgRole
  }
): Promise<AddExistingMemberResult> {
  // M4 role ceiling (defence in depth: the route gate already requires `admin`, the body schema
  // already excludes `owner`).
  if (ROLE_ORDER.indexOf(input.role) > ROLE_ORDER.indexOf(input.callerEffectiveRole)) {
    return { status: 'role_above_caller' }
  }

  const [target] = await tx
    .select({ userId: users.id, email: users.email })
    .from(orgMemberships)
    .innerJoin(users, eq(users.id, orgMemberships.userId))
    .where(
      and(
        eq(orgMemberships.orgId, input.orgId),
        eq(orgMemberships.userId, input.userId),
        eq(orgMemberships.status, 'active')
      )
    )
    .limit(1)
  if (!target) return { status: 'user_not_found' }

  if (await getProjectMembershipRole(tx, input)) return { status: 'already_member' }

  try {
    await tx.transaction((inner) =>
      inner.insert(projectMemberships).values({
        orgId: input.orgId,
        projectId: input.projectId,
        userId: input.userId,
        role: input.role,
      })
    )
  } catch (error) {
    if (isUniqueViolation(error)) return { status: 'already_member' }
    throw error
  }
  return {
    status: 'added',
    member: {
      userId: target.userId,
      email: target.email,
      displayName: target.email, // same D3 convention as the list route
      role: input.role,
    },
  }
}
