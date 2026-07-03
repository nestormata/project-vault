import { createHash, timingSafeEqual } from 'node:crypto'
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import {
  credentialDependencies,
  credentialVersions,
  rotationChecklistItems,
  rotations,
} from '@project-vault/db/schema'
import { withSecret } from '@project-vault/crypto'
import { encryptValue } from '../../lib/encrypt-value.js'
import {
  credentialExistsInProject,
  currentKeyVersion,
  isUniqueViolation,
  lockCredentialInProject,
} from '../credentials/db-helpers.js'
import type { InitiateRotationBody, ListRotationsQuery } from './schema.js'

export class RotationConflictError extends Error {
  constructor(public readonly rotationId: string | null) {
    super('A rotation is already in progress for this credential.')
  }
}

type ChecklistItemRow = typeof rotationChecklistItems.$inferSelect
type RotationRow = typeof rotations.$inferSelect

type InitiateRotationResult =
  | { status: 'credential_not_found' }
  | {
      status: 'initiated'
      rotation: RotationRow
      checklistItems: ChecklistItemRow[]
      sameValueAsPrevious: boolean
    }

/** Fixed-length digest comparison so a length difference between the two secrets never leaks
 *  timing information the way a naive `a === b` or raw `timingSafeEqual(bufA, bufB)` would. */
function constantTimeEqual(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a, 'utf8').digest()
  const digestB = createHash('sha256').update(b, 'utf8').digest()
  return timingSafeEqual(digestA, digestB)
}

async function tryAcquireRotationLock(
  tx: Tx,
  orgId: string,
  credentialId: string
): Promise<boolean> {
  const rows = await tx.execute(
    sql`SELECT pg_try_advisory_xact_lock(hashtextextended('rotation:' || ${orgId} || ':' || ${credentialId}, 0)) AS locked`
  )
  return Boolean((rows[0] as { locked: boolean } | undefined)?.locked)
}

async function findInProgressRotationId(tx: Tx, credentialId: string): Promise<string | null> {
  const [row] = await tx
    .select({ id: rotations.id })
    .from(rotations)
    .where(and(eq(rotations.credentialId, credentialId), eq(rotations.status, 'in_progress')))
    .limit(1)
  return row?.id ?? null
}

/**
 * AC-4/AC-5: acquires the non-blocking transaction-scoped advisory lock, then performs the
 * credential lookup, new-version insert, retention-lock UPDATE, checklist snapshot, and
 * rotations INSERT inside a nested (SAVEPOINT-backed) transaction — see ADR-5.1-01 and the
 * "Savepoint-guarded backstop insert" Dev Note. If the partial unique index
 * (idx_rotations_one_in_progress_per_credential) rejects the INSERT because the advisory lock
 * somehow didn't prevent a race, the nested transaction rolls back to its savepoint (undoing
 * the version insert/retention lock/checklist rows too) and the outer transaction is still
 * valid for the follow-up "who won" lookup.
 */
export async function initiateRotation(
  tx: Tx,
  input: {
    orgId: string
    projectId: string
    credentialId: string
    userId: string
    body: InitiateRotationBody
  }
): Promise<InitiateRotationResult> {
  const locked = await tryAcquireRotationLock(tx, input.orgId, input.credentialId)
  if (!locked) {
    throw new RotationConflictError(await findInProgressRotationId(tx, input.credentialId))
  }

  try {
    return await tx.transaction(async (trx) => {
      const credential = await lockCredentialInProject(trx, {
        credentialId: input.credentialId,
        projectId: input.projectId,
      })
      if (!credential) return { status: 'credential_not_found' as const }

      const [previousVersion] = await trx
        .select({
          id: credentialVersions.id,
          versionNumber: credentialVersions.versionNumber,
          encryptedValue: credentialVersions.encryptedValue,
        })
        .from(credentialVersions)
        .where(
          and(
            eq(credentialVersions.credentialId, input.credentialId),
            isNull(credentialVersions.purgedAt)
          )
        )
        .orderBy(desc(credentialVersions.versionNumber))
        .for('update')
        .limit(1)
      if (!previousVersion) {
        throw new Error(
          `initiateRotation: credential ${input.credentialId} has no non-purged version to supersede`
        )
      }

      let sameValueAsPrevious = false
      if (previousVersion.encryptedValue) {
        const previousPlaintext = await withSecret(previousVersion.encryptedValue, (plaintext) =>
          Promise.resolve(plaintext.toString('utf8'))
        )
        sameValueAsPrevious = constantTimeEqual(previousPlaintext, input.body.newValue)
      }

      const keyVersion = await currentKeyVersion(trx)
      const encryptedValue = await encryptValue(input.body.newValue)
      const [newVersion] = await trx
        .insert(credentialVersions)
        .values({
          orgId: input.orgId,
          credentialId: input.credentialId,
          encryptedValue,
          keyVersion,
          versionNumber: previousVersion.versionNumber + 1,
          createdBy: input.userId,
        })
        .returning()
      if (!newVersion)
        throw new Error('initiateRotation: new credential version insert returned no row')

      await trx
        .update(credentialVersions)
        .set({ rotationLockedAt: new Date() })
        .where(eq(credentialVersions.id, previousVersion.id))

      const dependencyRows = await trx
        .select({ id: credentialDependencies.id, systemName: credentialDependencies.systemName })
        .from(credentialDependencies)
        .where(
          and(
            eq(credentialDependencies.orgId, input.orgId),
            eq(credentialDependencies.credentialId, input.credentialId),
            isNull(credentialDependencies.archivedAt)
          )
        )

      const [rotation] = await trx
        .insert(rotations)
        .values({
          orgId: input.orgId,
          projectId: input.projectId,
          credentialId: input.credentialId,
          newVersionId: newVersion.id,
          previousVersionId: previousVersion.id,
          initiatedBy: input.userId,
          notes: input.body.notes ?? null,
        })
        .returning()
      if (!rotation) throw new Error('initiateRotation: rotation insert returned no row')

      const checklistItems =
        dependencyRows.length === 0
          ? []
          : await trx
              .insert(rotationChecklistItems)
              .values(
                dependencyRows.map((dep) => ({
                  orgId: input.orgId,
                  rotationId: rotation.id,
                  dependencyId: dep.id,
                  systemName: dep.systemName,
                }))
              )
              .returning()

      return { status: 'initiated' as const, rotation, checklistItems, sameValueAsPrevious }
    })
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new RotationConflictError(await findInProgressRotationId(tx, input.credentialId))
    }
    throw error
  }
}

function orderChecklistItems(items: ChecklistItemRow[]): ChecklistItemRow[] {
  return [...items].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
}

export function serializeRotationDetail(
  rotation: RotationRow,
  checklistItems: ChecklistItemRow[],
  extra: { sameValueAsPrevious?: boolean } = {}
) {
  return {
    id: rotation.id,
    credentialId: rotation.credentialId,
    projectId: rotation.projectId,
    status: rotation.status,
    version: rotation.version,
    initiatedBy: rotation.initiatedBy,
    initiatedAt: rotation.initiatedAt.toISOString(),
    completedAt: rotation.completedAt?.toISOString() ?? null,
    notes: rotation.notes,
    ...(extra.sameValueAsPrevious !== undefined
      ? { sameValueAsPrevious: extra.sameValueAsPrevious }
      : {}),
    checklistItems: orderChecklistItems(checklistItems).map((item) => ({
      id: item.id,
      dependencyId: item.dependencyId,
      systemName: item.systemName,
      status: item.status,
      confirmedBy: item.confirmedBy,
      confirmedAt: item.confirmedAt?.toISOString() ?? null,
    })),
  }
}

export const findCredentialInProject = credentialExistsInProject

export async function getRotationDetail(
  tx: Tx,
  params: { credentialId: string; projectId: string; rotationId: string }
) {
  const [rotation] = await tx
    .select()
    .from(rotations)
    .where(
      and(
        eq(rotations.id, params.rotationId),
        eq(rotations.credentialId, params.credentialId),
        eq(rotations.projectId, params.projectId)
      )
    )
    .limit(1)
  if (!rotation) return null

  const checklistItems = await tx
    .select()
    .from(rotationChecklistItems)
    .where(eq(rotationChecklistItems.rotationId, rotation.id))
    .orderBy(asc(rotationChecklistItems.createdAt))

  return serializeRotationDetail(rotation, checklistItems)
}

export async function listRotationHistory(
  tx: Tx,
  params: {
    credentialId: string
    projectId: string
    query: ListRotationsQuery
    limit: number
    offset: number
  }
) {
  const where = and(
    eq(rotations.credentialId, params.credentialId),
    eq(rotations.projectId, params.projectId)
  )

  const [{ total } = { total: 0 }] = await tx
    .select({ total: sql<number>`count(*)` })
    .from(rotations)
    .where(where)

  const rows = await tx
    .select({
      id: rotations.id,
      status: rotations.status,
      initiatedBy: rotations.initiatedBy,
      initiatedAt: rotations.initiatedAt,
      completedAt: rotations.completedAt,
    })
    .from(rotations)
    .where(where)
    .orderBy(desc(rotations.initiatedAt), desc(rotations.id))
    .limit(params.limit)
    .offset(params.offset)

  const rotationIds = rows.map((row) => row.id)
  const countRows =
    rotationIds.length === 0
      ? []
      : await tx
          .select({
            rotationId: rotationChecklistItems.rotationId,
            itemCount: sql<number>`count(*)`,
            confirmedCount: sql<number>`count(*) FILTER (WHERE ${rotationChecklistItems.status} = 'confirmed')`,
          })
          .from(rotationChecklistItems)
          .where(inArray(rotationChecklistItems.rotationId, rotationIds))
          .groupBy(rotationChecklistItems.rotationId)
  const countsByRotation = new Map(
    countRows.map((row) => [
      row.rotationId,
      { itemCount: Number(row.itemCount), confirmedCount: Number(row.confirmedCount) },
    ])
  )

  return {
    total: Number(total),
    items: rows.map((row) => ({
      id: row.id,
      status: row.status,
      initiatedBy: row.initiatedBy,
      initiatedAt: row.initiatedAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      itemCount: countsByRotation.get(row.id)?.itemCount ?? 0,
      confirmedCount: countsByRotation.get(row.id)?.confirmedCount ?? 0,
    })),
  }
}
