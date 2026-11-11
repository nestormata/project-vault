import { and, asc, eq, sql } from 'drizzle-orm'
import { type Tx } from '@project-vault/db'
import { orgMemberships, projectMemberships, projects, users } from '@project-vault/db/schema'

type OrgUserProject = { projectId: string; projectName: string; role: string }

/**
 * Story 4.3 AC-3/AC-19, Story 43-15 AC-4/AC-9: loads the target's membership row in this org,
 * locked FOR UPDATE, shared by the deactivate and remove routes. The lock is held until the
 * route's transaction ends, so a racing deactivate/remove re-checks rather than races, and a
 * rotation the target starts meanwhile waits on it (initiateRotation's FOR SHARE) and is refused.
 */
export async function lockOrgMembershipForUpdate(
  tx: Tx,
  orgId: string,
  userId: string
): Promise<{ orgRole: string; status: string } | undefined> {
  const [row] = await tx
    .select({ orgRole: orgMemberships.role, status: orgMemberships.status })
    .from(orgMemberships)
    .where(and(eq(orgMemberships.userId, userId), eq(orgMemberships.orgId, orgId)))
    .for('update')
    .limit(1)
  return row
}

/** Locks every org owner in userId order so concurrent last-owner checks serialize without deadlock. */
export async function orgOwnersForUpdate(tx: Tx, orgId: string): Promise<{ userId: string }[]> {
  return tx
    .select({ userId: orgMemberships.userId })
    .from(orgMemberships)
    .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.role, 'owner')))
    .orderBy(asc(orgMemberships.userId))
    .for('update')
}

export async function otherOrgOwnersForUpdate(
  tx: Tx,
  orgId: string,
  userId: string
): Promise<{ userId: string }[]> {
  const owners = await orgOwnersForUpdate(tx, orgId)
  return owners.filter((row) => row.userId !== userId)
}

export async function soleOwnerProjectsForUpdate(
  tx: Tx,
  orgId: string,
  userId: string
): Promise<{ projectId: string; projectName: string }[]> {
  const soleOwnerProjects = await tx.execute(sql`
    SELECT pm.project_id AS "projectId", p.name AS "projectName"
    FROM project_memberships pm
    JOIN projects p ON p.id = pm.project_id
    WHERE pm.org_id = ${orgId}
      AND pm.user_id = ${userId}
      AND pm.role = 'owner'
      AND NOT EXISTS (
        SELECT 1 FROM project_memberships pm2
        WHERE pm2.project_id = pm.project_id
          AND pm2.role = 'owner'
          AND pm2.user_id != ${userId}
      )
    FOR UPDATE OF pm
  `)
  return soleOwnerProjects as unknown as { projectId: string; projectName: string }[]
}

/**
 * AC-2: list every org member with their per-project role chips. Two batched queries grouped in
 * application code (avoids an N+1 over projects). Lives here rather than inline in `routes.ts` so
 * the route stays a thin `secureRoute` registration — `route-audit.test.ts` scans `routes.ts` for
 * bare `.get(...)`/`.delete(...)` calls (Map/Drizzle) that its parser cannot distinguish from raw
 * Fastify route shorthands.
 */
export async function listOrgUsers(tx: Tx, orgId: string) {
  const orgUsers = await tx
    .select({
      userId: orgMemberships.userId,
      email: users.email,
      orgRole: orgMemberships.role,
      status: orgMemberships.status,
    })
    .from(orgMemberships)
    .innerJoin(users, eq(users.id, orgMemberships.userId))
    .where(eq(orgMemberships.orgId, orgId))

  const projectRows = await tx
    .select({
      userId: projectMemberships.userId,
      projectId: projectMemberships.projectId,
      projectName: projects.name,
      role: projectMemberships.role,
    })
    .from(projectMemberships)
    .innerJoin(projects, eq(projects.id, projectMemberships.projectId))
    .where(eq(projectMemberships.orgId, orgId))

  const projectsByUser = new Map<string, OrgUserProject[]>()
  for (const row of projectRows) {
    const list = projectsByUser.get(row.userId) ?? []
    list.push({ projectId: row.projectId, projectName: row.projectName, role: row.role })
    projectsByUser.set(row.userId, list)
  }

  return orgUsers.map((u) => ({
    userId: u.userId,
    email: u.email,
    displayName: u.email, // D3: no dedicated profile column; derive from email.
    orgRole: u.orgRole,
    status: u.status as 'active' | 'deactivated',
    projects: projectsByUser.get(u.userId) ?? [],
  }))
}

/**
 * AC-3: cascade-remove a user's project memberships, then their org membership, inside the caller's
 * transaction. Returns the number of project memberships removed (for the audit payload). Callers
 * MUST run all removal guards (self, D9 rank, D5 last-org-owner, D5 sole-project-owner) before
 * invoking this — it performs the mutations unconditionally.
 */
export async function removeUserFromOrgMemberships(
  tx: Tx,
  orgId: string,
  userId: string
): Promise<{ removedProjectCount: number }> {
  const removedProjects = await tx
    .delete(projectMemberships)
    .where(and(eq(projectMemberships.orgId, orgId), eq(projectMemberships.userId, userId)))
    .returning({ projectId: projectMemberships.projectId })

  await tx
    .delete(orgMemberships)
    .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)))

  return { removedProjectCount: removedProjects.length }
}
