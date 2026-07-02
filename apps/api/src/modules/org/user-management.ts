import { and, eq } from 'drizzle-orm'
import { type Tx } from '@project-vault/db'
import { orgMemberships, projectMemberships, projects, users } from '@project-vault/db/schema'

type OrgUserProject = { projectId: string; projectName: string; role: string }

/**
 * AC-2: list every org member with their per-project role chips. Two batched queries grouped in
 * application code (avoids an N+1 over projects). Lives here rather than inline in `routes.ts` so
 * the route stays a thin `secureRoute` registration — `route-audit.test.ts` scans `routes.ts` for
 * bare `.get(...)`/`.delete(...)` calls (Map/Drizzle) that its parser cannot distinguish from raw
 * Fastify route shorthands.
 */
export async function listOrgUsers(tx: Tx, orgId: string) {
  const orgUsers = await tx
    .select({ userId: orgMemberships.userId, email: users.email, orgRole: orgMemberships.role })
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
