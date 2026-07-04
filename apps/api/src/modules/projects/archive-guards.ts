import { and, eq, inArray } from 'drizzle-orm'
import type { FastifyReply } from 'fastify'
import type { Tx } from '@project-vault/db'
import { projects, rotations } from '@project-vault/db/schema'

/** Standard 410 body every write guard on an archived project MUST return (ADR-4.4-01). */
export const PROJECT_ARCHIVED_ERROR = {
  code: 'project_archived',
  message: 'This project is archived and cannot be modified. Unarchive it first.',
} as const

/**
 * Returns the ids of rotations that block archival for a project.
 * Blocking statuses: 'in_progress' (active workflow) and 'stale_recovery' (unresolved; would be
 * orphaned by archival). 'break_glass_overlap' does NOT block — it is a self-expiring drain
 * window past the human-action point (ADR-4.4-03).
 */
export async function findBlockingRotationIds(tx: Tx, projectId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: rotations.id })
    .from(rotations)
    .where(
      and(
        eq(rotations.projectId, projectId),
        inArray(rotations.status, ['in_progress', 'stale_recovery'])
      )
    )
  return rows.map((r) => r.id)
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
