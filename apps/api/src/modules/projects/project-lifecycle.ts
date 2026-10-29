import { and, asc, eq, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm'
import type { AnyColumn } from 'drizzle-orm'
import type { PgTable } from 'drizzle-orm/pg-core'
import { forEachSequential } from '../../lib/for-each-sequential.js'
import type { Tx } from '@project-vault/db'
import {
  certRecords,
  credentials,
  credentialShares,
  domainRecords,
  extensionLifecycleEvents,
  machineUsers,
  monitoringAlerts,
  paymentRecords,
  pendingImports,
  projectInvitations,
  projectMemberships,
  projects,
  rotations,
  serviceEndpoints,
  statusPages,
} from '@project-vault/db/schema'
import { PROJECT_DELETE_GRACE_DAYS } from '@project-vault/shared'
import { isUuid } from '../../middleware/rls.js'
import { activeMachineUserKeysQuery } from '../machine-users/archival-check.js'
import { findBlockingRotationIds } from './archive-guards.js'

/**
 * Story 72-9 — soft delete with a grace period.
 *
 * A deleted project keeps its row (and every child row) for `PROJECT_DELETE_GRACE_DAYS`, then the
 * purge job hard-deletes it. While deleted it is also archived (`archived_at` is set at delete
 * time), so every archive-aware reader already hides it, and the secureRoute gate answers 404 for
 * every `:projectId` route except restore. Restore clears the deletion markers and leaves the
 * project ARCHIVED (the caller unarchives it as a separate, explicit step).
 */
export { PROJECT_DELETE_GRACE_DAYS }
const DAY_MS = 86_400_000

export function purgeAfterFor(deletedAt: Date): Date {
  return new Date(deletedAt.getTime() + PROJECT_DELETE_GRACE_DAYS * DAY_MS)
}

/** True when the project exists in the caller's org (RLS) and is soft-deleted. */
export async function isProjectDeleted(tx: Tx, projectId: string): Promise<boolean> {
  // A non-UUID can never match a row; the route's own parameter validation answers it.
  if (!isUuid(projectId)) return false
  const [row] = await tx
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), isNotNull(projects.deletedAt)))
    .limit(1)
  return row !== undefined
}

export type DeleteBlockers = { blocked: false } | { blocked: true; body: Record<string, unknown> }

/**
 * What stops a delete: an active rotation or an active machine-user API key (same two blockers as
 * archive). Active shares are NOT a blocker: delete revokes them.
 */
export async function findDeleteBlockers(tx: Tx, projectId: string): Promise<DeleteBlockers> {
  const rotationIds = await findBlockingRotationIds(tx, projectId)
  if (rotationIds.length > 0) {
    return { blocked: true, body: { error: 'active_rotations', rotationIds } }
  }
  const keys = await activeMachineUserKeysQuery(tx, projectId)
  if (keys.length > 0) {
    return {
      blocked: true,
      body: {
        error: 'active_machine_user_keys',
        machineUserIds: keys.map((row) => row.machineUserId),
      },
    }
  }
  return { blocked: false }
}

export type RevokedShare = { id: string; credentialId: string; attributeKeys: string[] | null }

/** Revokes every `active` share on a credential of this project; returns the revoked rows. */
export function revokeProjectShares(tx: Tx, projectId: string): Promise<RevokedShare[]> {
  return tx
    .update(credentialShares)
    .set({ status: 'revoked', revokedAt: new Date() })
    .where(
      and(
        eq(credentialShares.status, 'active'),
        inArray(
          credentialShares.credentialId,
          tx
            .select({ id: credentials.id })
            .from(credentials)
            .where(eq(credentials.projectId, projectId))
        )
      )
    )
    .returning({
      id: credentialShares.id,
      credentialId: credentialShares.credentialId,
      attributeKeys: credentialShares.attributeKeys,
    })
}

export type SoftDeleteResult = {
  id: string
  name: string
  slug: string
  deletedAt: Date
  purgeAfter: Date
  wasArchived: boolean
}

/**
 * Marks the project deleted. Returns null when it was already deleted (a racing request won).
 * `archivedAt` is kept when already set, so the original archive time survives a restore.
 */
export async function markProjectDeleted(
  tx: Tx,
  input: { projectId: string; actorUserId: string; wasArchived: boolean; now: Date }
): Promise<SoftDeleteResult | null> {
  const purgeAfter = purgeAfterFor(input.now)
  const [row] = await tx
    .update(projects)
    .set({
      deletedAt: input.now,
      deletedBy: input.actorUserId,
      purgeAfter,
      archivedAt: input.wasArchived ? undefined : input.now,
      updatedAt: input.now,
    })
    .where(and(eq(projects.id, input.projectId), isNull(projects.deletedAt)))
    .returning({ id: projects.id, name: projects.name, slug: projects.slug })
  if (!row) return null
  return { ...row, deletedAt: input.now, purgeAfter, wasArchived: input.wasArchived }
}

/** Clears the deletion markers; the project stays archived. Null when it was not deleted. */
export async function markProjectRestored(
  tx: Tx,
  projectId: string
): Promise<{ id: string; name: string; slug: string; archivedAt: Date | null } | null> {
  const [row] = await tx
    .update(projects)
    .set({ deletedAt: null, deletedBy: null, purgeAfter: null, updatedAt: new Date() })
    .where(
      and(eq(projects.id, projectId), isNotNull(projects.deletedAt), isNull(projects.purgedAt))
    )
    .returning({
      id: projects.id,
      name: projects.name,
      slug: projects.slug,
      archivedAt: projects.archivedAt,
    })
  return row ?? null
}

export type DeletedProjectRow = {
  id: string
  name: string
  slug: string
  deletedAt: Date
  purgeAfter: Date
}

/** Every soft-deleted project in the org (RLS), oldest deletion first. */
export async function listDeletedProjects(tx: Tx): Promise<DeletedProjectRow[]> {
  const rows = await tx
    .select({
      id: projects.id,
      name: projects.name,
      slug: projects.slug,
      deletedAt: projects.deletedAt,
      purgeAfter: projects.purgeAfter,
    })
    .from(projects)
    .where(and(isNotNull(projects.deletedAt), isNull(projects.purgedAt)))
    .orderBy(asc(projects.deletedAt))
  return rows.flatMap((row) =>
    row.deletedAt && row.purgeAfter
      ? [{ ...row, deletedAt: row.deletedAt, purgeAfter: row.purgeAfter }]
      : []
  )
}

/** Ids of this org's projects whose grace period has ended (call inside an org-scoped tx). */
export async function findPurgeDueProjectIds(tx: Tx, now: Date): Promise<string[]> {
  const rows = await tx
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(isNotNull(projects.deletedAt), isNull(projects.purgedAt), lte(projects.purgeAfter, now))
    )
    .orderBy(asc(projects.purgeAfter))
    .limit(100)
  return rows.map((row) => row.id)
}

/**
 * Every table with a foreign key to `projects` except `audit_log_entries`, in a delete order that
 * satisfies the foreign keys between them (rotations reference credentials; status pages and
 * monitoring alerts reference service endpoints). The purge deletes the rows of each by
 * `project_id`; their own children (versions, shares, API keys, health checks...) go by cascade.
 * A guard test fails when a new table references `projects` and is missing from this list.
 */
export const PROJECT_PURGE_TABLES: { table: PgTable; projectId: AnyColumn }[] = [
  { table: statusPages, projectId: statusPages.projectId },
  { table: monitoringAlerts, projectId: monitoringAlerts.projectId },
  { table: serviceEndpoints, projectId: serviceEndpoints.projectId },
  { table: rotations, projectId: rotations.projectId },
  { table: machineUsers, projectId: machineUsers.projectId },
  { table: credentials, projectId: credentials.projectId },
  { table: certRecords, projectId: certRecords.projectId },
  { table: domainRecords, projectId: domainRecords.projectId },
  { table: paymentRecords, projectId: paymentRecords.projectId },
  { table: pendingImports, projectId: pendingImports.projectId },
  { table: projectInvitations, projectId: projectInvitations.projectId },
  { table: extensionLifecycleEvents, projectId: extensionLifecycleEvents.projectId },
  { table: projectMemberships, projectId: projectMemberships.projectId },
]

/**
 * Erases the data of a project whose grace period ended and turns its row into a tombstone:
 * identifying fields are blanked, the slug is replaced (so the old one is free again), and the
 * creation request id is cleared (so a replayed create cannot find it). Returns false when the
 * project was restored or purged by a concurrent request (nothing is changed then).
 */
export async function eraseProjectData(tx: Tx, projectId: string, now: Date): Promise<boolean> {
  const [due] = await tx
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(
        eq(projects.id, projectId),
        isNotNull(projects.deletedAt),
        isNull(projects.purgedAt),
        lte(projects.purgeAfter, now)
      )
    )
    .for('update')
    .limit(1)
  if (!due) return false
  await forEachSequential(PROJECT_PURGE_TABLES, ({ table, projectId: column }) =>
    tx.delete(table).where(eq(column, projectId))
  )
  await tx
    .update(projects)
    .set({
      name: 'Purged project',
      slug: sql`'purged-' || ${projects.id}::text`,
      description: null,
      tags: [],
      urls: [],
      creationRequestId: null,
      createdBy: null,
      purgedAt: now,
      updatedAt: now,
    })
    .where(eq(projects.id, projectId))
  return true
}
