import { and, eq, inArray } from 'drizzle-orm'
import type { FastifyReply } from 'fastify'
import type { Tx } from '@project-vault/db'
import { projects, rotations } from '@project-vault/db/schema'
import { activeMachineUserKeysQuery } from '../machine-users/archival-check.js'

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
 *
 * Story 5.1 has shipped and the `rotations` table now exists, so this queries it directly via a
 * typed Drizzle query (the former ADR-4.4-02 table-existence seam was removed per the CI guard in
 * `apps/api/src/modules/projects/archive-guards.test.ts`).
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
 * Story 7.2 D12 — closes the stub: returns whether the project has any active (non-revoked,
 * non-expired) machine-user API key that would block archival. Delegates to
 * `activeMachineUserKeysQuery()` so this guard and `GET .../machine-users/active-keys` (AC-23)
 * never drift into disagreeing about what counts as "active".
 */
export async function hasActiveMachineUserKeys(tx: Tx, projectId: string): Promise<boolean> {
  const rows = await activeMachineUserKeysQuery(tx, projectId)
  return rows.length > 0
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
