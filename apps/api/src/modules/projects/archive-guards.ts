import { eq, sql } from 'drizzle-orm'
import type { FastifyReply } from 'fastify'
import type { Tx } from '@project-vault/db'
import { projects } from '@project-vault/db/schema'

/** Standard 410 body every write guard on an archived project MUST return (ADR-4.4-01). */
export const PROJECT_ARCHIVED_ERROR = {
  code: 'project_archived',
  message: 'This project is archived and cannot be modified. Unarchive it first.',
} as const

/**
 * ADR-4.4-02 table-existence seam: the `rotations` table is created in Epic 5 (Story 5.1), which
 * has not shipped yet at the time 4.4 was implemented. Detects whether the table exists so
 * `findBlockingRotationIds` can degrade to "no block" instead of failing to build/run.
 *
 * Once Story 5.1 ships, replace `findBlockingRotationIds`'s raw SQL with a typed Drizzle query
 * against the `rotations` schema object and delete this function — see
 * `apps/api/src/modules/projects/archive-guards.test.ts` for the CI guard that catches drift.
 */
async function rotationsTableExists(tx: Tx): Promise<boolean> {
  const res = await tx.execute(sql`SELECT to_regclass('public.rotations') AS reg`)
  return (res as unknown as Array<{ reg: string | null }>)[0]?.reg !== null
}

/**
 * Returns the ids of rotations that block archival for a project.
 * Blocking statuses: 'in_progress' (active workflow) and 'stale_recovery' (unresolved; would be
 * orphaned by archival). 'break_glass_overlap' does NOT block — it is a self-expiring drain
 * window past the human-action point (ADR-4.4-03).
 *
 * Cross-epic seam (ADR-4.4-02): if the `rotations` table does not yet exist (4.4 built before
 * 5.1), this returns [] (no block) and QA must hold FR63 sign-off until Epic 5 is delivered.
 */
export async function findBlockingRotationIds(tx: Tx, projectId: string): Promise<string[]> {
  const tableExists = await rotationsTableExists(tx)
  if (!tableExists) return [] // Epic 5 not yet delivered — documented degradation (ADR-4.4-02)

  const rows = await tx.execute(sql`
    SELECT id FROM rotations
    WHERE project_id = ${projectId}
      AND status IN ('in_progress', 'stale_recovery')
  `)
  return (rows as unknown as Array<{ id: string }>).map((r) => r.id)
}

/**
 * Returns whether the project has active machine-user API keys that would block archival.
 * STUBBED until Epic 7 delivers GET /api/v1/projects/:projectId/machine-users/active-keys.
 */
// TODO: Epic 7 — check for active machine user API key access
export async function hasActiveMachineUserKeys(_tx: Tx, _projectId: string): Promise<false> {
  return false
}

/** Returns true if the project is archived (caller should reject the mutation with 410). */
export async function isProjectArchived(tx: Tx, projectId: string): Promise<boolean> {
  const [row] = await tx
    .select({ archivedAt: projects.archivedAt })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)
  return row?.archivedAt != null
}

/**
 * Shared one-line write-guard call for the AC-5 mutation routes: sends the 410 response and
 * returns true if the project is archived, so callers can `if (await rejectIfArchived(...)) return
 * reply`. Centralized so the identical 3-statement guard isn't repeated verbatim across every
 * guarded route (credentials create/versions/tags/dependencies, project metadata/tags, transfer).
 */
export async function rejectIfProjectArchived(
  tx: Tx,
  projectId: string,
  reply: FastifyReply
): Promise<boolean> {
  if (!(await isProjectArchived(tx, projectId))) return false
  reply.status(410).send(PROJECT_ARCHIVED_ERROR)
  return true
}
