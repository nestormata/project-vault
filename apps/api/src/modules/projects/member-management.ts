import { and, count, eq } from 'drizzle-orm'
import { type Tx } from '@project-vault/db'
import { projectMemberships } from '@project-vault/db/schema'

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
