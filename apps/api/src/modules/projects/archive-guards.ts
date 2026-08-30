import { and, eq, inArray } from 'drizzle-orm'
import type { FastifyReply } from 'fastify'
import type { Tx } from '@project-vault/db'
import { credentials, credentialShares, projects, rotations } from '@project-vault/db/schema'
import { activeMachineUserKeysQuery } from '../machine-users/archival-check.js'

/** Standard 410 body every write guard on an archived project MUST return (ADR-4.4-01). */
export const PROJECT_ARCHIVED_ERROR = {
  code: 'project_archived',
  message: 'This project is archived and cannot be modified. Unarchive it first.',
} as const

// Story 5.6 AC-10.1: the "active rotation" set that blocks project/credential archival — kept in
// sync with AC-2.6's idx_rotations_one_active_per_credential predicate by referencing this same
// exported constant from both places, rather than two independently-maintained literal lists.
// 'in_progress' is kept for historical-row compatibility during the AC-7 migration window (never
// written by new code once this story ships). 'promoted' is new here: a promoted-but-unretired
// rotation still has a staged value only retrievable via the credential's own routes (AC-8) —
// archiving out from under it would destroy the only way to ever independently retrieve it again.
export const BLOCKING_ROTATION_STATUSES = [
  'in_progress',
  'staged',
  'promoted',
  'stale_recovery',
] as const

/**
 * Returns the ids of rotations that block archival for a project.
 * Blocking statuses: BLOCKING_ROTATION_STATUSES above. 'break_glass_overlap' does NOT block — it
 * is a self-expiring drain window past the human-action point (ADR-4.4-03).
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
      and(eq(rotations.projectId, projectId), inArray(rotations.status, BLOCKING_ROTATION_STATUSES))
    )
  return rows.map((r) => r.id)
}

/**
 * Story 17.1 AC-19 — extends the archival-dependency guard the epic's own Round 3 finding already
 * generalized to cover "staged rotations and active shares" as a class: returns the ids of
 * `active` credential_shares for any credential in this project, blocking project archival the
 * same way an in-progress rotation does. Joins through `credentials` (credential_shares has no
 * direct projectId column) — scoped to the project, not the whole org.
 */
export async function findBlockingShareIds(tx: Tx, projectId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: credentialShares.id })
    .from(credentialShares)
    .innerJoin(credentials, eq(credentialShares.credentialId, credentials.id))
    .where(and(eq(credentials.projectId, projectId), eq(credentialShares.status, 'active')))
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

// Story 28.5 — the caller-authorization decision behind both project and credential archival
// (4.4 AC-2/AC-6/ADR-4.4-05) is identical: project owner OR org owner, nothing else. Factored out
// as a pure function so `projects/routes.ts` and `credentials/routes.ts` share one implementation
// instead of two verbatim copies drifting apart; each call site still does its own
// `callerProjectRole` lookup since that part legitimately differs by module.
export function resolveArchiveAuthorization(
  callerRole: string | undefined,
  orgRole: string
): 'project_owner' | 'org_owner' | null {
  if (callerRole === 'owner') return 'project_owner'
  if (orgRole === 'owner') return 'org_owner'
  return null
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
