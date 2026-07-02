import { and, eq } from 'drizzle-orm'
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
