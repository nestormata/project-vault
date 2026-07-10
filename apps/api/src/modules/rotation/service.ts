import { createHash, timingSafeEqual } from 'node:crypto'
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import {
  credentialDependencies,
  credentials,
  credentialVersions,
  projects,
  rotationChecklistItems,
  rotations,
} from '@project-vault/db/schema'
import { withSecret } from '@project-vault/crypto'
import { nextCronOccurrence } from '@project-vault/shared'
import { env } from '../../config/env.js'
import { encryptValue } from '../../lib/encrypt-value.js'
import {
  awaitCredentialScopedLockRelease,
  tryAcquireCredentialScopedLock,
  tryAcquireRotationScopedLock,
} from '../../lib/rotation-locks.js'
import { enqueueSecurityAlertNotification } from '../../notifications/dispatcher.js'
import type { NotificationQueueJob } from '../../notifications/dispatcher.js'
import {
  currentKeyVersion,
  isLockNotAvailable,
  isUniqueViolation,
  lockCredentialInProject,
} from '../credentials/db-helpers.js'
import type {
  BreakGlassRotationBody,
  CompleteRotationBody,
  ConfirmChecklistItemBody,
  FailChecklistItemBody,
  InitiateRotationBody,
  ListRotationsQuery,
} from './schema.js'

export class RotationConflictError extends Error {
  constructor(public readonly rotationId: string | null) {
    super('A rotation is already in progress for this credential.')
  }
}

type ChecklistItemRow = typeof rotationChecklistItems.$inferSelect
type RotationRow = typeof rotations.$inferSelect

type InitiateRotationResult =
  | { status: 'credential_not_found' }
  | { status: 'project_archived' }
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
  const locked = await tryAcquireCredentialScopedLock(tx, input.orgId, input.credentialId)
  if (!locked) {
    await awaitCredentialScopedLockRelease(tx, input.orgId, input.credentialId)
    throw new RotationConflictError(await findInProgressRotationId(tx, input.credentialId))
  }

  try {
    return await tx.transaction(async (trx) => {
      // Story 5.5 AC-1: closes the TOCTOU race between Story 4.4's project archive/unarchive
      // handlers (which lock the project row `FOR UPDATE` for their whole transaction, checking
      // `archivedAt` immediately after acquiring it) and rotation initiation. Taking the SAME
      // `FOR UPDATE` lock on the identical row here — before any checklist/version writes —
      // guarantees the two operations serialize: whichever transaction acquires the lock first
      // commits, and the other sees its result (either an archived project, or a newly-created
      // blocking rotation) once it proceeds. Never both succeed.
      const [projectRow] = await trx
        .select({ archivedAt: projects.archivedAt })
        .from(projects)
        .where(eq(projects.id, input.projectId))
        .for('update')
        .limit(1)
      if (!projectRow) return { status: 'credential_not_found' as const }
      if (projectRow.archivedAt !== null) return { status: 'project_archived' as const }

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

// Checklist items for a rotation are all written inside the same transaction as a single
// batch INSERT, and Postgres's `now()` (what `.defaultNow()` uses) is fixed for the entire
// transaction — every row in the batch gets an IDENTICAL `created_at`. Sorting on `createdAt`
// alone is therefore not the "stable, deterministic order" AC-4 step 8 requires: a fresh
// `ORDER BY created_at` query has no guaranteed tie-break and can return a different row order
// across separate calls. `id` (immutable, never reused) is the tiebreaker that actually makes
// the order deterministic and repeatable, even though it isn't literal insertion order.
function orderChecklistItems(items: ChecklistItemRow[]): ChecklistItemRow[] {
  return [...items].sort((a, b) => {
    const byCreatedAt = a.createdAt.getTime() - b.createdAt.getTime()
    return byCreatedAt !== 0 ? byCreatedAt : a.id.localeCompare(b.id)
  })
}

// Story 5.2 AC-1/AC-13: extended with retryCount/retryScheduledAt/lastFailureReason/
// lastActedBy/lastActedAt (FR66) and notes (surfaced in the confirm/fail/retry mutation
// responses — AC-2/AC-4).
export function serializeChecklistItem(item: ChecklistItemRow) {
  return {
    id: item.id,
    dependencyId: item.dependencyId,
    systemName: item.systemName,
    status: item.status,
    confirmedBy: item.confirmedBy,
    confirmedAt: item.confirmedAt?.toISOString() ?? null,
    retryCount: item.retryCount,
    retryScheduledAt: item.retryScheduledAt?.toISOString() ?? null,
    lastFailureReason: item.lastFailureReason,
    lastActedBy: item.lastActedBy,
    lastActedAt: item.lastActedAt?.toISOString() ?? null,
    notes: item.notes,
  }
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
    checklistItems: orderChecklistItems(checklistItems).map(serializeChecklistItem),
  }
}

export { credentialExistsInProject as findCredentialInProject } from '../credentials/db-helpers.js'

export async function getRotationDetail(
  tx: Tx,
  params: { credentialId: string; projectId: string; rotationId: string }
) {
  const rotation = await findRotationInScope(tx, params)
  if (!rotation) return null

  // See orderChecklistItems' comment: created_at ties are the norm (same-transaction batch
  // insert), so `id` is required as a secondary sort key for a deterministic, repeatable order.
  const checklistItems = await tx
    .select()
    .from(rotationChecklistItems)
    .where(eq(rotationChecklistItems.rotationId, rotation.id))
    .orderBy(asc(rotationChecklistItems.createdAt), asc(rotationChecklistItems.id))

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

// ============================================================================
// Story 5.2 — checklist confirm/fail/retry/complete + upcoming rotations
// ============================================================================

async function findRotationInScope(
  tx: Tx,
  params: { projectId: string; credentialId: string; rotationId: string }
): Promise<RotationRow | null> {
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
  return rotation ?? null
}

async function findChecklistItemInScope(
  tx: Tx,
  params: { rotationId: string; itemId: string }
): Promise<ChecklistItemRow | null> {
  const [item] = await tx
    .select()
    .from(rotationChecklistItems)
    .where(
      and(
        eq(rotationChecklistItems.id, params.itemId),
        eq(rotationChecklistItems.rotationId, params.rotationId)
      )
    )
    .limit(1)
  return item ?? null
}

/** Shared by confirm/fail/retry: the "item_not_found" branch is identical across all three. */
async function findItemOrNotFound(
  tx: Tx,
  params: { rotationId: string; itemId: string }
): Promise<ChecklistItemRow | { outcome: 'item_not_found' }> {
  const item = await findChecklistItemInScope(tx, params)
  return item ?? { outcome: 'item_not_found' }
}

/** Builds the WHERE clause every checklist-item status UPDATE shares: scoped to the item +
 *  rotation, optionally guarded by the item's current status (the CAS-adjacent status guard
 *  fail/retry rely on; confirm's equivalent guard already happened via its own status check). */
function itemScopeWhere(
  params: { itemId: string; rotationId: string },
  status?: ChecklistItemRow['status']
) {
  const base = [
    eq(rotationChecklistItems.id, params.itemId),
    eq(rotationChecklistItems.rotationId, params.rotationId),
  ]
  return status ? and(...base, eq(rotationChecklistItems.status, status)) : and(...base)
}

/** AC-8 step 4: the CAS backstop. Returns the new version, or null if the row was not found
 *  at the expected observed version (lock bypassed by a hypothetical direct-DB caller). */
async function casIncrementRotationVersion(
  tx: Tx,
  rotationId: string,
  observedVersion: number
): Promise<number | null> {
  const [row] = await tx
    .update(rotations)
    .set({ version: observedVersion + 1, updatedAt: new Date() })
    .where(and(eq(rotations.id, rotationId), eq(rotations.version, observedVersion)))
    .returning({ version: rotations.version })
  return row?.version ?? null
}

/** The `WHERE id = ... AND rotation_id = ... AND status = '<expected>'` UPDATEs in confirm/fail/
 *  retry can only return zero rows if the item's status changed between our own read and write
 *  within this same locked transaction — impossible given the rotation-scoped advisory lock is
 *  held for the whole transaction. Throws (never returns undefined) so callers can destructure
 *  the row without a `!` non-null assertion (forbidden by this repo's eslint config). */
function assertUpdatedRow<T>(row: T | undefined, context: string): T {
  if (row === undefined) {
    throw new Error(`${context}: expected UPDATE ... RETURNING to return exactly one row`)
  }
  return row
}

/** Runs the AC-8 CAS backstop *before* the caller performs its item-level write. This ordering
 *  matters for atomicity: under normal operation the advisory lock already guarantees this CAS
 *  never loses (it's a backstop, not the primary mechanism — AC-8), but if it ever does lose
 *  (e.g. the lock is bypassed by a hypothetical direct-DB caller), bumping `rotations.version`
 *  first means the item-status UPDATE is simply never reached — no compensating "undo" write is
 *  needed, and the transaction cannot commit a state change the client was told was rejected.
 *  (An earlier version of this helper ran the item write first and the CAS second, which let a
 *  lost CAS race commit the item's status change anyway while still replying 409 — fixed here.) */
async function reserveRotationVersion(
  tx: Tx,
  scopeParams: { projectId: string; credentialId: string; rotationId: string },
  observedVersion: number
): Promise<
  | { outcome: 'ok'; rotationVersion: number }
  | { outcome: 'concurrent_modification'; currentVersion: number | null }
> {
  const newVersion = await casIncrementRotationVersion(tx, scopeParams.rotationId, observedVersion)
  if (newVersion !== null) return { outcome: 'ok', rotationVersion: newVersion }
  const current = await findRotationInScope(tx, scopeParams)
  return { outcome: 'concurrent_modification', currentVersion: current?.version ?? null }
}

/** Shared by confirm/fail/retry/max-retries-exceeded: reserve the AC-8 CAS version bump (see
 *  reserveRotationVersion's doc comment for why that must happen first), then perform the
 *  item's own status-transition UPDATE guarded by `fromStatus` (when the caller hasn't already
 *  ruled out other statuses via its own precondition check). */
async function reserveVersionAndUpdateItem(
  tx: Tx,
  params: { itemId: string; rotationId: string; projectId: string; credentialId: string },
  rotationVersion: number,
  fromStatus: ChecklistItemRow['status'] | undefined,
  setFields: Partial<{
    [K in keyof typeof rotationChecklistItems.$inferInsert]:
      (typeof rotationChecklistItems.$inferInsert)[K] | SQL
  }>,
  label: string
): Promise<
  | { outcome: 'concurrent_modification'; currentVersion: number | null }
  | { item: ChecklistItemRow; rotationVersion: number }
> {
  const cas = await reserveRotationVersion(tx, params, rotationVersion)
  if (cas.outcome === 'concurrent_modification') return cas
  const [updated] = await tx
    .update(rotationChecklistItems)
    .set(setFields)
    .where(itemScopeWhere(params, fromStatus))
    .returning()
  // Safe to assert non-null: the advisory lock held for this whole transaction rules out any
  // concurrent delete/status-change between the caller's own precondition check and this write.
  return { item: assertUpdatedRow(updated, label), rotationVersion: cas.rotationVersion }
}

type RotationLockOutcome =
  | { outcome: 'locked_conflict'; currentVersion: number | null }
  | { outcome: 'not_found' }
  | { outcome: 'not_active'; rotation: RotationRow }
  | { outcome: 'ok'; rotation: RotationRow }

/** Narrows a resolved RotationLockOutcome to its 'ok' variant, or throws — used after every
 *  early-return check on lockOutcomeToFailure()'s result already ruled out the other three
 *  variants, so this should only ever fire if a new outcome is added to RotationLockOutcome
 *  without updating lockOutcomeToFailure() to match. */
function assertRotationLockOk(
  lockResult: RotationLockOutcome
): asserts lockResult is { outcome: 'ok'; rotation: RotationRow } {
  if (lockResult.outcome !== 'ok') throw new Error('unreachable rotation lock outcome')
}

type RotationScopedLockResult =
  | { outcome: 'locked_conflict'; currentVersion: number | null }
  | { outcome: 'not_found' }
  | { outcome: 'found'; rotation: RotationRow }

/** Shared by every rotation-scoped-lock mutation (5.2's confirm/fail/retry/complete AND 5.3's
 *  resume/abandon, AC-15): acquire the advisory lock, then resolve the rotation (tenant-scoped
 *  by projectId/credentialId/rotationId together, per AC-17) — callers apply their own
 *  status-eligibility check (in_progress vs. stale_recovery) on top of this shared shape. */
async function acquireRotationScopedLockAndFind(
  tx: Tx,
  params: { orgId: string; projectId: string; credentialId: string; rotationId: string }
): Promise<RotationScopedLockResult> {
  const locked = await tryAcquireRotationScopedLock(tx, params.orgId, params.rotationId)
  if (!locked) {
    const existing = await findRotationInScope(tx, params)
    return { outcome: 'locked_conflict', currentVersion: existing?.version ?? null }
  }
  const rotation = await findRotationInScope(tx, params)
  if (!rotation) return { outcome: 'not_found' }
  return { outcome: 'found', rotation }
}

/** AC-8's uniform entry sequence for all four checklist mutation endpoints. */
async function acquireAndLoadRotation(
  tx: Tx,
  params: { orgId: string; projectId: string; credentialId: string; rotationId: string }
): Promise<RotationLockOutcome> {
  const result = await acquireRotationScopedLockAndFind(tx, params)
  if (result.outcome !== 'found') return result
  if (result.rotation.status !== 'in_progress') {
    return { outcome: 'not_active', rotation: result.rotation }
  }
  return { outcome: 'ok', rotation: result.rotation }
}

// Shared across confirm/fail/retry — the AC-8 uniform lock/scope failure variants. Each
// operation's own result type below unions this with its operation-specific outcomes only, so
// TypeScript can exhaustively narrow a route handler without any cross-operation outcome
// (e.g. confirm's route never has to account for 'max_retries_exceeded').
export type ChecklistLockFailure =
  | { outcome: 'locked_conflict'; currentVersion: number | null }
  | { outcome: 'rotation_not_found' }
  | { outcome: 'rotation_not_active'; status: string }
  | { outcome: 'item_not_found' }
  | { outcome: 'concurrent_modification'; currentVersion: number | null }

export type ConfirmChecklistItemResult =
  | ChecklistLockFailure
  | { outcome: 'already_confirmed'; item: ChecklistItemRow }
  | { outcome: 'confirmed'; item: ChecklistItemRow; rotationVersion: number }

export type FailChecklistItemResult =
  | ChecklistLockFailure
  | { outcome: 'invalid_item_status'; item: ChecklistItemRow }
  | {
      outcome: 'failed'
      item: ChecklistItemRow
      rotationVersion: number
      jobs: NotificationQueueJob[]
    }

export type RetryChecklistItemResult =
  | ChecklistLockFailure
  | { outcome: 'invalid_item_status'; item: ChecklistItemRow }
  | { outcome: 'retried'; item: ChecklistItemRow; rotationVersion: number }
  | {
      outcome: 'max_retries_exceeded'
      item: ChecklistItemRow
      retryCount: number
      maxRetries: number
      jobs: NotificationQueueJob[]
    }

function lockOutcomeToFailure(
  lockResult: RotationLockOutcome
):
  | { outcome: 'locked_conflict'; currentVersion: number | null }
  | { outcome: 'rotation_not_found' }
  | { outcome: 'rotation_not_active'; status: string }
  | null {
  if (lockResult.outcome === 'locked_conflict') {
    return { outcome: 'locked_conflict', currentVersion: lockResult.currentVersion }
  }
  if (lockResult.outcome === 'not_found') return { outcome: 'rotation_not_found' }
  if (lockResult.outcome === 'not_active') {
    return { outcome: 'rotation_not_active', status: lockResult.rotation.status }
  }
  return null
}

/** AC-8/AC-17's uniform entry sequence shared by confirm/fail/retry: acquire + status-check the
 *  rotation, then look up the item — collapsing the identical lock-then-item preamble each of
 *  those three functions needs before diverging into its own item-status precondition check. */
async function acquireLockAndItem(
  tx: Tx,
  params: {
    orgId: string
    projectId: string
    credentialId: string
    rotationId: string
    itemId: string
  }
): Promise<
  | { outcome: 'locked_conflict'; currentVersion: number | null }
  | { outcome: 'rotation_not_found' }
  | { outcome: 'rotation_not_active'; status: string }
  | { outcome: 'item_not_found' }
  | { lockResult: { outcome: 'ok'; rotation: RotationRow }; item: ChecklistItemRow }
> {
  const lockResult = await acquireAndLoadRotation(tx, params)
  const earlyResult = lockOutcomeToFailure(lockResult)
  if (earlyResult) return earlyResult
  assertRotationLockOk(lockResult)

  const itemResult = await findItemOrNotFound(tx, params)
  if ('outcome' in itemResult) return itemResult
  return { lockResult, item: itemResult }
}

/** AC-2/AC-3: confirm — item -> 'confirmed' from unconfirmed/failed/max_retries_exceeded.
 *  Rejects re-confirming an already-confirmed item with 409 before any write. */
export async function confirmChecklistItem(
  tx: Tx,
  params: {
    orgId: string
    projectId: string
    credentialId: string
    rotationId: string
    itemId: string
    userId: string
    body: ConfirmChecklistItemBody
  }
): Promise<ConfirmChecklistItemResult> {
  const acquired = await acquireLockAndItem(tx, params)
  if ('outcome' in acquired) return acquired
  const { lockResult, item } = acquired
  if (item.status === 'confirmed') return { outcome: 'already_confirmed', item }

  const now = new Date()
  const result = await reserveVersionAndUpdateItem(
    tx,
    params,
    lockResult.rotation.version,
    undefined,
    {
      status: 'confirmed',
      confirmedBy: params.userId,
      confirmedAt: now,
      lastActedBy: params.userId,
      lastActedAt: now,
      ...(params.body.notes ? { notes: params.body.notes } : {}),
    },
    'confirmChecklistItem'
  )
  if ('outcome' in result) return result

  return {
    outcome: 'confirmed' as const,
    item: result.item,
    rotationVersion: result.rotationVersion,
  }
}

/** AC-4/AC-5/FR75: fail — item 'unconfirmed' -> 'failed'. Alert queued every call. */
export async function failChecklistItem(
  tx: Tx,
  params: {
    orgId: string
    projectId: string
    credentialId: string
    rotationId: string
    itemId: string
    userId: string
    body: FailChecklistItemBody
  }
): Promise<FailChecklistItemResult> {
  const acquired = await acquireLockAndItem(tx, params)
  if ('outcome' in acquired) return acquired
  const { lockResult, item } = acquired
  if (item.status !== 'unconfirmed') return { outcome: 'invalid_item_status', item }

  const now = new Date()
  const retryScheduledAt = params.body.retryScheduledAt
    ? new Date(params.body.retryScheduledAt)
    : null
  // The alert enqueue below is intentionally strictly after this: reserveVersionAndUpdateItem
  // reserves the AC-8 CAS bump before writing, so a lost race returns here and never reaches it.
  const result = await reserveVersionAndUpdateItem(
    tx,
    params,
    lockResult.rotation.version,
    'unconfirmed',
    {
      status: 'failed',
      lastFailureReason: params.body.reason,
      retryScheduledAt,
      lastActedBy: params.userId,
      lastActedAt: now,
    },
    'failChecklistItem'
  )
  if ('outcome' in result) return result
  const failedItem = result.item

  const jobs = await enqueueSecurityAlertNotification({
    orgId: params.orgId,
    templateId: 'rotation.confirmation_failed',
    payload: {
      rotationId: params.rotationId,
      itemId: params.itemId,
      credentialId: params.credentialId,
      systemName: failedItem.systemName,
      reason: params.body.reason,
    },
    severity: 'warning',
    tx,
  })
  return {
    outcome: 'failed' as const,
    item: failedItem,
    rotationVersion: result.rotationVersion,
    jobs,
  }
}

type RetryScopeParams = {
  orgId: string
  projectId: string
  credentialId: string
  rotationId: string
  itemId: string
  userId: string
}

/** The over-limit transition (AC-7/AC-E5b): item 'failed' -> 'max_retries_exceeded'. A real,
 *  alerted state transition even though the request itself is rejected — split out of
 *  retryChecklistItem to keep that function's own branching count small. */
async function applyMaxRetriesExceeded(
  tx: Tx,
  params: RetryScopeParams,
  observedVersion: number,
  maxRetries: number
): Promise<RetryChecklistItemResult> {
  const now = new Date()
  // The critical alert enqueue below is intentionally strictly after this: a lost CAS race
  // returns here (see reserveVersionAndUpdateItem's doc comment) and never reaches it.
  const result = await reserveVersionAndUpdateItem(
    tx,
    params,
    observedVersion,
    'failed',
    { status: 'max_retries_exceeded', lastActedBy: params.userId, lastActedAt: now },
    'applyMaxRetriesExceeded'
  )
  if ('outcome' in result) return result
  const exceededItem = result.item

  const jobs = await enqueueSecurityAlertNotification({
    orgId: params.orgId,
    templateId: 'rotation.max_retries_exceeded',
    payload: {
      rotationId: params.rotationId,
      itemId: params.itemId,
      credentialId: params.credentialId,
      systemName: exceededItem.systemName,
      retryCount: exceededItem.retryCount,
    },
    severity: 'critical',
    tx,
  })
  return {
    outcome: 'max_retries_exceeded' as const,
    item: exceededItem,
    retryCount: exceededItem.retryCount,
    maxRetries,
    jobs,
  }
}

/** The ordinary retry transition: item 'failed' -> 'unconfirmed', retryCount += 1. */
async function applyRetry(
  tx: Tx,
  params: RetryScopeParams,
  observedVersion: number
): Promise<RetryChecklistItemResult> {
  const now = new Date()
  const result = await reserveVersionAndUpdateItem(
    tx,
    params,
    observedVersion,
    'failed',
    {
      status: 'unconfirmed',
      retryCount: sql`${rotationChecklistItems.retryCount} + 1`,
      lastActedBy: params.userId,
      lastActedAt: now,
    },
    'applyRetry'
  )
  if ('outcome' in result) return result

  return { outcome: 'retried' as const, item: result.item, rotationVersion: result.rotationVersion }
}

/** AC-6/AC-7/AC-E5b: retry — item 'failed' -> 'unconfirmed' (retryCount += 1), or, once the
 *  cap is reached, 'failed' -> 'max_retries_exceeded' (a rejected request with a real,
 *  alerted state transition as a side effect). */
export async function retryChecklistItem(
  tx: Tx,
  params: RetryScopeParams
): Promise<RetryChecklistItemResult> {
  const acquired = await acquireLockAndItem(tx, params)
  if ('outcome' in acquired) return acquired
  const { lockResult, item } = acquired
  if (item.status !== 'failed') return { outcome: 'invalid_item_status', item }

  // AC-7: read fresh on every call — never cached/snapshotted per rotation or item.
  const maxRetries = env.ROTATION_MAX_RETRIES
  if (item.retryCount >= maxRetries) {
    return applyMaxRetriesExceeded(tx, params, lockResult.rotation.version, maxRetries)
  }
  return applyRetry(tx, params, lockResult.rotation.version)
}

export type CompleteRotationResult =
  | { outcome: 'locked_conflict'; currentVersion: number | null }
  | { outcome: 'rotation_not_found' }
  | { outcome: 'rotation_not_active'; status: string }
  | {
      outcome: 'checklist_incomplete'
      pendingItems: { id: string; systemName: string; status: string }[]
      totalItemCount: number
    }
  | { outcome: 'acknowledgement_required' }
  | { outcome: 'concurrent_modification'; currentVersion: number | null }
  | {
      outcome: 'completed'
      rotation: RotationRow
      checklistItems: ChecklistItemRow[]
      singleActorAttested: boolean
    }

/** Story 5.5 AC-2: surfaces (doesn't block — see the AC's "flag, don't block" precedent) the
 *  case where the same user both initiated the rotation and confirmed every checklist item
 *  themselves, so a completion built entirely on one person's self-attestation is visible after
 *  the fact without a manual confirmedBy-vs-initiatedBy cross-reference. Vacuously false for a
 *  zero-dependency (acknowledged) completion — there is no checklist self-confirmation to flag
 *  in that case, only the separate acknowledgedNoDependencies gate.
 *
 *  Code-review fix: both confirmedBy and initiatedBy are nullable (onDelete: 'set null') — a
 *  naive Set-membership check would false-positive to `true` whenever every confirming user's
 *  AND the initiating user's accounts have since been deleted (NULL === NULL), even though
 *  those were, by definition, different (now-gone) people. Require the sole confirmer to be a
 *  real, non-null user id that matches the initiator. Split out of completeRotation purely to
 *  keep that function's own cyclomatic complexity down (this repo's eslint `complexity` rule
 *  caps at 10) — same rationale as breakGlassRotation's split-out helpers above. */
function computeSingleActorAttested(
  items: ChecklistItemRow[],
  initiatedBy: string | null
): boolean {
  const confirmedByUsers = new Set(items.map((item) => item.confirmedBy))
  const [soleConfirmedBy] = confirmedByUsers
  return (
    items.length > 0 &&
    confirmedByUsers.size === 1 &&
    soleConfirmedBy !== null &&
    soleConfirmedBy === initiatedBy
  )
}

/** AC-9/AC-10/AC-11/AC-12: complete — blocked unless every item is confirmed (or the caller
 *  acknowledges a zero-dependency rotation). On success, retires the superseded credential
 *  version by clearing rotation_locked_at (ADR-5.2-02) atomically with the status transition. */
export async function completeRotation(
  tx: Tx,
  params: {
    orgId: string
    projectId: string
    credentialId: string
    rotationId: string
    userId: string
    body: CompleteRotationBody
  }
): Promise<CompleteRotationResult> {
  const lockResult = await acquireAndLoadRotation(tx, params)
  const earlyResult = lockOutcomeToFailure(lockResult)
  if (earlyResult) return earlyResult
  assertRotationLockOk(lockResult)

  const items = await tx
    .select()
    .from(rotationChecklistItems)
    .where(eq(rotationChecklistItems.rotationId, params.rotationId))
    .orderBy(asc(rotationChecklistItems.createdAt), asc(rotationChecklistItems.id))

  const pending = items.filter((item) => item.status !== 'confirmed')
  if (pending.length > 0) {
    return {
      outcome: 'checklist_incomplete',
      pendingItems: pending.map((item) => ({
        id: item.id,
        systemName: item.systemName,
        status: item.status,
      })),
      totalItemCount: items.length,
    }
  }

  if (items.length === 0 && params.body.acknowledgedNoDependencies !== true) {
    return { outcome: 'acknowledgement_required' }
  }

  // AC-9 step 3: status transition and the CAS version bump happen in the single UPDATE, so a
  // lost race (version mismatch) simply returns zero rows — same CAS semantics as AC-8's other
  // three mutations, no separate version-only UPDATE needed.
  const [updatedRotation] = await tx
    .update(rotations)
    .set({
      status: 'completed',
      completedAt: new Date(),
      version: lockResult.rotation.version + 1,
      updatedAt: new Date(),
    })
    .where(
      and(eq(rotations.id, params.rotationId), eq(rotations.version, lockResult.rotation.version))
    )
    .returning()
  if (!updatedRotation) {
    const current = await findRotationInScope(tx, params)
    return { outcome: 'concurrent_modification', currentVersion: current?.version ?? null }
  }

  // ADR-5.2-02: "retiring" the superseded version means clearing rotation_locked_at, not
  // setting a status column (credential_versions has no status column — confirmed against
  // the actual Story 2.2 schema).
  await tx
    .update(credentialVersions)
    .set({ rotationLockedAt: null })
    .where(eq(credentialVersions.id, lockResult.rotation.previousVersionId))

  return {
    outcome: 'completed',
    rotation: updatedRotation,
    checklistItems: items,
    singleActorAttested: computeSingleActorAttested(items, lockResult.rotation.initiatedBy),
  }
}

export type UpcomingRotationResult = {
  credentialId: string
  credentialName: string
  nextDueAt: Date
  status: 'pending' | 'overdue'
}

type ScheduledCredentialRow = {
  id: string
  name: string
  rotationSchedule: string | null
  createdAt: Date
}

// Edge-case fix: computeUpcomingRotations' two internal queries previously had no LIMIT — only
// the final results array was capped (to 20) after the fact by callers. For an org with many
// scheduled credentials, or long-lived credentials with a large rotation history, this was
// unbounded per-request DB read work on every dashboard load (getOrgDashboardData runs it with
// no projectId, i.e. org-wide, on every request). These caps are a deterministic (ordered)
// operational safety valve, not a correctness requirement.
const MAX_SCHEDULED_CREDENTIALS_PER_QUERY = 1000
const MAX_ROTATION_HISTORY_ROWS_PER_QUERY = 5000

async function fetchCredentialsWithSchedule(
  tx: Tx,
  projectId?: string
): Promise<ScheduledCredentialRow[]> {
  return tx
    .select({
      id: credentials.id,
      name: credentials.name,
      rotationSchedule: credentials.rotationSchedule,
      createdAt: credentials.createdAt,
    })
    .from(credentials)
    .where(
      projectId
        ? and(isNotNull(credentials.rotationSchedule), eq(credentials.projectId, projectId))
        : isNotNull(credentials.rotationSchedule)
    )
    .orderBy(asc(credentials.id))
    .limit(MAX_SCHEDULED_CREDENTIALS_PER_QUERY)
}

type LatestRotationByCredential = Map<string, { completedAt: Date | null; updatedAt: Date }>

/** Single query for every rotation belonging to the given credentials, ordered so the first
 *  row per credentialId is that credential's most recent rotation (createdAt DESC) — avoids an
 *  N+1 "latest rotation per credential" query. Also returns which credentials currently have an
 *  active (in_progress/stale_recovery) rotation, from the same result set. */
async function fetchRotationSummaryByCredential(
  tx: Tx,
  credentialIds: string[]
): Promise<{ latestByCredential: LatestRotationByCredential; activeCredentialIds: Set<string> }> {
  const latestByCredential: LatestRotationByCredential = new Map()
  const activeCredentialIds = new Set<string>()
  if (credentialIds.length === 0) return { latestByCredential, activeCredentialIds }

  const rotationRows = await tx
    .select({
      credentialId: rotations.credentialId,
      status: rotations.status,
      completedAt: rotations.completedAt,
      updatedAt: rotations.updatedAt,
    })
    .from(rotations)
    .where(inArray(rotations.credentialId, credentialIds))
    .orderBy(rotations.credentialId, desc(rotations.createdAt))
    .limit(MAX_ROTATION_HISTORY_ROWS_PER_QUERY)

  for (const row of rotationRows) {
    if (!latestByCredential.has(row.credentialId)) {
      latestByCredential.set(row.credentialId, {
        completedAt: row.completedAt,
        updatedAt: row.updatedAt,
      })
    }
    if (row.status === 'in_progress' || row.status === 'stale_recovery') {
      activeCredentialIds.add(row.credentialId)
    }
  }
  return { latestByCredential, activeCredentialIds }
}

/** AC-14 step 1: completedAt if the most recent rotation is 'completed', else updatedAt
 *  (covers non-completed terminal transitions), else the credential's own createdAt if it has
 *  no rotation history at all. */
function resolveReferencePoint(
  cred: ScheduledCredentialRow,
  latest: { completedAt: Date | null; updatedAt: Date } | undefined
): Date {
  if (!latest) return cred.createdAt
  return latest.completedAt ?? latest.updatedAt
}

/** AC-14 steps 2-3: compute the next due date and decide inclusion/status, or null if the
 *  credential has no schedule, an unparseable schedule, or falls outside the horizon. */
function resolveUpcomingRotation(
  cred: ScheduledCredentialRow,
  referencePoint: Date,
  now: number,
  horizonMs: number
): UpcomingRotationResult | null {
  if (!cred.rotationSchedule) return null

  let nextDueAt: Date
  try {
    nextDueAt = nextCronOccurrence(cred.rotationSchedule, referencePoint)
  } catch {
    // Malformed/unparseable cron (shouldn't happen given write-time validation, but skip
    // rather than take down the whole dashboard/upcoming-rotations response).
    return null
  }
  if (nextDueAt.getTime() > now + horizonMs) return null

  return {
    credentialId: cred.id,
    credentialName: cred.name,
    nextDueAt,
    status: nextDueAt.getTime() < now ? 'overdue' : 'pending',
  }
}

/** FR65/AC-14/AC-15: shared helper for the upcoming-rotations read endpoint AND both dashboard
 *  placeholders (org "overdue rotations", project "upcoming rotations") — one cron-computation
 *  code path, no duplication. `projectId` omitted means org-wide (within RLS scope). */
export async function computeUpcomingRotations(
  tx: Tx,
  opts: { projectId?: string; horizonDays: number }
): Promise<UpcomingRotationResult[]> {
  const credentialRows = await fetchCredentialsWithSchedule(tx, opts.projectId)
  if (credentialRows.length === 0) return []

  const { latestByCredential, activeCredentialIds } = await fetchRotationSummaryByCredential(
    tx,
    credentialRows.map((row) => row.id)
  )

  const now = Date.now()
  const horizonMs = opts.horizonDays * 24 * 60 * 60 * 1000
  const results: UpcomingRotationResult[] = []

  for (const cred of credentialRows) {
    if (activeCredentialIds.has(cred.id)) continue
    const referencePoint = resolveReferencePoint(cred, latestByCredential.get(cred.id))
    const resolved = resolveUpcomingRotation(cred, referencePoint, now, horizonMs)
    if (resolved) results.push(resolved)
  }

  results.sort((a, b) => a.nextDueAt.getTime() - b.nextDueAt.getTime())
  return results
}

// ============================================================================
// Story 5.3 — break-glass emergency rotation + stale-recovery resume/abandon
// ============================================================================

type DependentSystemRow = { id: string; systemName: string }

export type BreakGlassResult =
  | { status: 'lock_contention' }
  | { status: 'credential_not_found' }
  | {
      status: 'ok'
      rotation: RotationRow
      supersededRotationId: string | null
      previousVersionOverlap: { versionNumber: number; breakGlassOverlapExpiresAt: Date }
      dependentSystems: DependentSystemRow[]
      // Story 5.5 AC-4: true when this call was a rapid double-submit within the idempotency
      // window and `rotation` is the FIRST call's already-created rotation, not a new one —
      // callers (routes.ts) use this to skip re-writing audit/security-alert/notification
      // side effects a second time for what is really the same logical event.
      deduped: boolean
    }

async function activeDependentSystems(tx: Tx, orgId: string, credentialId: string) {
  return tx
    .select({ id: credentialDependencies.id, systemName: credentialDependencies.systemName })
    .from(credentialDependencies)
    .where(
      and(
        eq(credentialDependencies.orgId, orgId),
        eq(credentialDependencies.credentialId, credentialId),
        isNull(credentialDependencies.archivedAt)
      )
    )
}

/** AC-5/CR6: if an existing rotation is `in_progress` or `stale_recovery` for this credential,
 *  abandon it (identical mechanics to the manual `abandon` endpoint, AC-12) before break-glass
 *  inserts its own rotation row. `FOR UPDATE NOWAIT` (not a blocking read) is deliberate — see
 *  AC-5/AC-6: a concurrent 5.2 confirm/fail/retry/complete call holds a *rotation*-scoped
 *  advisory lock, a different key domain break-glass's *credential*-scoped lock never serializes
 *  against, so a blocking row-lock read here could silently stall break-glass behind an
 *  unrelated in-flight human action — defeating its "act in seconds" premise. Returns the
 *  superseded rotation's id, or null if there was nothing active to supersede. Throws (for the
 *  caller to map to 409 rotation_lock_contention) if the NOWAIT lock acquisition fails. */
async function supersedeActiveRotation(
  tx: Tx,
  params: { orgId: string; credentialId: string }
): Promise<string | null> {
  const [active] = await tx
    .select({
      id: rotations.id,
      version: rotations.version,
      newVersionId: rotations.newVersionId,
      previousVersionId: rotations.previousVersionId,
    })
    .from(rotations)
    .where(
      and(
        eq(rotations.credentialId, params.credentialId),
        inArray(rotations.status, ['in_progress', 'stale_recovery'])
      )
    )
    .for('update', { noWait: true })
    .limit(1)
  if (!active) return null

  await tx
    .update(rotations)
    .set({ status: 'abandoned', version: active.version + 1, updatedAt: new Date() })
    .where(eq(rotations.id, active.id))
  await tx
    .update(credentialVersions)
    .set({ abandonedAt: new Date() })
    .where(eq(credentialVersions.id, active.newVersionId))
  await tx
    .update(credentialVersions)
    .set({ rotationLockedAt: null })
    .where(eq(credentialVersions.id, active.previousVersionId))

  return active.id
}

/** Story 5.5 AC-4: a rotation in `break_glass_complete` status doesn't match
 *  `supersedeActiveRotation`'s filter (`in_progress`/`stale_recovery` only — break-glass is
 *  already terminal the instant it's created), so two SEQUENTIAL break-glass calls close
 *  together in time (e.g. a double-click or client retry — NOT the true-concurrency case the
 *  credential-scoped advisory lock already catches, since that lock releases the instant the
 *  first call's transaction commits) would otherwise each independently succeed, silently
 *  consuming two credential versions. Returns the most recent `break_glass_complete` rotation
 *  for this credential if one was created within `windowMs`, else null. */
async function findRecentDuplicateBreakGlass(
  tx: Tx,
  credentialId: string,
  windowMs: number
): Promise<RotationRow | null> {
  const [row] = await tx
    .select()
    .from(rotations)
    .where(
      and(
        eq(rotations.credentialId, credentialId),
        eq(rotations.status, 'break_glass_complete'),
        gt(rotations.initiatedAt, new Date(Date.now() - windowMs))
      )
    )
    .orderBy(desc(rotations.initiatedAt))
    .limit(1)
  return row ?? null
}

/** Reconstructs the AC-4 idempotent-replay result from the first call's already-created
 *  rotation — split out of `breakGlassRotation` purely to keep that function's own cyclomatic
 *  complexity down (this repo's eslint `complexity` rule caps at 10). */
async function buildDedupedBreakGlassResult(
  tx: Tx,
  orgId: string,
  credentialId: string,
  duplicate: RotationRow
): Promise<BreakGlassResult> {
  const [previousVersion] = await tx
    .select({
      versionNumber: credentialVersions.versionNumber,
      breakGlassOverlapExpiresAt: credentialVersions.breakGlassOverlapExpiresAt,
    })
    .from(credentialVersions)
    .where(eq(credentialVersions.id, duplicate.previousVersionId))
    .limit(1)
  const dependentSystems = await activeDependentSystems(tx, orgId, credentialId)
  return {
    status: 'ok',
    rotation: duplicate,
    supersededRotationId: null,
    previousVersionOverlap: {
      versionNumber: previousVersion?.versionNumber ?? 0,
      breakGlassOverlapExpiresAt: previousVersion?.breakGlassOverlapExpiresAt ?? new Date(),
    },
    dependentSystems,
    deduped: true,
  }
}

type BreakGlassVersionResult = {
  previousVersion: { id: string; versionNumber: number }
  newVersion: { id: string }
}

/** AC-2 step 1 (reuses the identical FOR UPDATE pattern as 5.1's normal initiation) plus the
 *  new-version insert — split out of `breakGlassRotation` purely to keep that function's own
 *  cyclomatic complexity down (this repo's eslint `complexity` rule caps at 10). */
async function createBreakGlassVersion(
  tx: Tx,
  input: { orgId: string; credentialId: string; userId: string; newValue: string }
): Promise<BreakGlassVersionResult> {
  // Excludes abandonedAt too (CR5) — critical when supersedeActiveRotation just abandoned the
  // previously "highest" version above: this correctly resolves back to whatever was current
  // before either rotation started, not the just-abandoned half-finished value (AC-5).
  const [previousVersion] = await tx
    .select({ id: credentialVersions.id, versionNumber: credentialVersions.versionNumber })
    .from(credentialVersions)
    .where(
      and(
        eq(credentialVersions.credentialId, input.credentialId),
        isNull(credentialVersions.purgedAt),
        isNull(credentialVersions.abandonedAt)
      )
    )
    .orderBy(desc(credentialVersions.versionNumber))
    .for('update')
    .limit(1)
  if (!previousVersion) {
    throw new Error(
      `breakGlassRotation: credential ${input.credentialId} has no non-purged/non-abandoned version to supersede`
    )
  }

  // Anti-pattern guard (Dev Notes): version numbers stay strictly monotonic regardless of
  // abandonment — MUST be MAX(version_number)+1 across ALL rows (including abandoned ones), NOT
  // previousVersion.versionNumber+1. If supersedeActiveRotation just abandoned an existing
  // rotation's new version above, that version's number is still "used" and must never be
  // reissued (same invariant addCredentialVersion's next-version computation already protects).
  const [maxVersionRow] = await tx
    .select({ max: sql<number>`COALESCE(MAX(${credentialVersions.versionNumber}), 0)` })
    .from(credentialVersions)
    .where(eq(credentialVersions.credentialId, input.credentialId))
  const nextVersionNumber = Number(maxVersionRow?.max ?? 0) + 1

  const keyVersion = await currentKeyVersion(tx)
  const encryptedValue = await encryptValue(input.newValue)
  const [newVersion] = await tx
    .insert(credentialVersions)
    .values({
      orgId: input.orgId,
      credentialId: input.credentialId,
      encryptedValue,
      keyVersion,
      versionNumber: nextVersionNumber,
      createdBy: input.userId,
    })
    .returning()
  if (!newVersion)
    throw new Error('breakGlassRotation: new credential version insert returned no row')

  return { previousVersion, newVersion }
}

/** AC-2/AC-5/AC-6: break-glass emergency rotation — immediately writes a new live value,
 *  supersedes (auto-abandons) any existing active rotation for the credential (CR6), and puts
 *  the superseded version into a purge-protected overlap window (CR1) rather than retiring it
 *  immediately (contradicting PRD FR108's literal "immediately retires" text — see ADR-5.3-01).
 *  No checklist items are created — break-glass's entire premise is skipping the checklist. */
export async function breakGlassRotation(
  tx: Tx,
  input: {
    orgId: string
    projectId: string
    credentialId: string
    userId: string
    body: BreakGlassRotationBody
    overlapMinutes: number
    idempotencyWindowSeconds: number
  }
): Promise<BreakGlassResult> {
  const locked = await tryAcquireCredentialScopedLock(tx, input.orgId, input.credentialId)
  if (!locked) return { status: 'lock_contention' }

  const credential = await lockCredentialInProject(tx, {
    credentialId: input.credentialId,
    projectId: input.projectId,
  })
  if (!credential) return { status: 'credential_not_found' }

  const duplicate = await findRecentDuplicateBreakGlass(
    tx,
    input.credentialId,
    input.idempotencyWindowSeconds * 1000
  )
  if (duplicate) {
    return buildDedupedBreakGlassResult(tx, input.orgId, input.credentialId, duplicate)
  }

  let supersededRotationId: string | null
  try {
    supersededRotationId = await supersedeActiveRotation(tx, {
      orgId: input.orgId,
      credentialId: input.credentialId,
    })
  } catch (error) {
    if (isLockNotAvailable(error)) return { status: 'lock_contention' }
    throw error
  }

  const { previousVersion, newVersion } = await createBreakGlassVersion(tx, {
    orgId: input.orgId,
    credentialId: input.credentialId,
    userId: input.userId,
    newValue: input.body.newValue,
  })

  const breakGlassOverlapExpiresAt = new Date(Date.now() + input.overlapMinutes * 60_000)
  await tx
    .update(credentialVersions)
    .set({ rotationLockedAt: new Date(), breakGlassOverlapExpiresAt })
    .where(eq(credentialVersions.id, previousVersion.id))

  const dependentSystems = await activeDependentSystems(tx, input.orgId, input.credentialId)

  const [rotation] = await tx
    .insert(rotations)
    .values({
      orgId: input.orgId,
      projectId: input.projectId,
      credentialId: input.credentialId,
      newVersionId: newVersion.id,
      previousVersionId: previousVersion.id,
      status: 'break_glass_complete',
      initiatedBy: input.userId,
      notes: input.body.reason,
    })
    .returning()
  if (!rotation) throw new Error('breakGlassRotation: rotation insert returned no row')

  return {
    status: 'ok',
    rotation,
    supersededRotationId,
    previousVersionOverlap: {
      versionNumber: previousVersion.versionNumber,
      breakGlassOverlapExpiresAt,
    },
    dependentSystems,
    deduped: false,
  }
}

export function serializeBreakGlassRotation(result: {
  rotation: RotationRow
  previousVersionOverlap: { versionNumber: number; breakGlassOverlapExpiresAt: Date }
  // Story 5.5 AC-4 code-review fix: surfaced in the response only when true (same "flag,
  // don't block", present-only-when-true convention as sameValueAsPrevious above) — a
  // deduped call returns the FIRST call's rotation, so without this the caller has no way to
  // tell their own submission (newValue/reason) was silently discarded in favor of an earlier
  // one, which the response body would otherwise look identical to a real success.
  deduped?: boolean
}) {
  return {
    ...serializeRotationDetail(result.rotation, []),
    previousVersionOverlap: {
      versionNumber: result.previousVersionOverlap.versionNumber,
      breakGlassOverlapExpiresAt:
        result.previousVersionOverlap.breakGlassOverlapExpiresAt.toISOString(),
    },
    ...(result.deduped ? { deduped: true as const } : {}),
  }
}

type StaleRotationLockOutcome =
  | { outcome: 'locked_conflict'; currentVersion: number | null }
  | { outcome: 'rotation_not_found' }
  | { outcome: 'rotation_not_stale'; status: string }
  | { outcome: 'ok'; rotation: RotationRow }

/** AC-11/AC-12/AC-15/AC-17: shared entry sequence for resume/abandon — acquire 5.2's
 *  rotation-scoped advisory lock, then resolve + status-check the rotation (must be
 *  stale_recovery, checked immediately, before any other write — AC-17). */
async function acquireAndLoadStaleRotation(
  tx: Tx,
  params: { orgId: string; projectId: string; credentialId: string; rotationId: string }
): Promise<StaleRotationLockOutcome> {
  const result = await acquireRotationScopedLockAndFind(tx, params)
  if (result.outcome === 'locked_conflict') return result
  if (result.outcome === 'not_found') return { outcome: 'rotation_not_found' }
  if (result.rotation.status !== 'stale_recovery') {
    return { outcome: 'rotation_not_stale', status: result.rotation.status }
  }
  return { outcome: 'ok', rotation: result.rotation }
}

export type ResumeRotationResult =
  | { outcome: 'locked_conflict'; currentVersion: number | null }
  | { outcome: 'rotation_not_found' }
  | { outcome: 'rotation_not_stale'; status: string }
  | { outcome: 'concurrent_modification'; currentVersion: number | null }
  | { outcome: 'resumed'; rotation: RotationRow; checklistItems: ChecklistItemRow[] }

/** AC-11: stale_recovery -> in_progress. Checklist items are left exactly as they are — "checklist
 *  preserved" per epics.md; no additional item mutation happens on resume. */
/** AC-11/AC-12/AC-15: the CAS-guarded status transition shared by resume ('in_progress') and
 *  abandon ('abandoned') — both leave stale_recovery via an identical UPDATE...RETURNING shape,
 *  differing only in the target status. A zero-row result means either a lost CAS race or (in
 *  practice, ruled out by the advisory lock held for this whole transaction) a status that
 *  changed underneath the caller — both map to the identical 409 concurrent_modification. */
async function transitionOutOfStaleRecovery(
  tx: Tx,
  params: { orgId: string; projectId: string; credentialId: string; rotationId: string },
  observedVersion: number,
  toStatus: 'in_progress' | 'abandoned'
): Promise<
  | { outcome: 'concurrent_modification'; currentVersion: number | null }
  | { outcome: 'ok'; rotation: RotationRow }
> {
  const [updated] = await tx
    .update(rotations)
    .set({ status: toStatus, version: observedVersion + 1, updatedAt: new Date() })
    .where(
      and(
        eq(rotations.id, params.rotationId),
        eq(rotations.status, 'stale_recovery'),
        eq(rotations.version, observedVersion)
      )
    )
    .returning()
  if (!updated) {
    const current = await findRotationInScope(tx, params)
    return { outcome: 'concurrent_modification', currentVersion: current?.version ?? null }
  }
  return { outcome: 'ok', rotation: updated }
}

export async function resumeRotation(
  tx: Tx,
  params: { orgId: string; projectId: string; credentialId: string; rotationId: string }
): Promise<ResumeRotationResult> {
  const lockResult = await acquireAndLoadStaleRotation(tx, params)
  if (lockResult.outcome !== 'ok') return lockResult

  const transition = await transitionOutOfStaleRecovery(
    tx,
    params,
    lockResult.rotation.version,
    'in_progress'
  )
  if (transition.outcome !== 'ok') return transition
  const updated = transition.rotation

  const checklistItems = await tx
    .select()
    .from(rotationChecklistItems)
    .where(eq(rotationChecklistItems.rotationId, params.rotationId))
    .orderBy(asc(rotationChecklistItems.createdAt), asc(rotationChecklistItems.id))

  return { outcome: 'resumed', rotation: updated, checklistItems }
}

export type AbandonRotationResult =
  | { outcome: 'locked_conflict'; currentVersion: number | null }
  | { outcome: 'rotation_not_found' }
  | { outcome: 'rotation_not_stale'; status: string }
  | { outcome: 'concurrent_modification'; currentVersion: number | null }
  | { outcome: 'abandoned'; rotation: RotationRow; checklistItems: ChecklistItemRow[] }

/** AC-12/CR5: stale_recovery -> abandoned. The never-completed new version is marked
 *  abandonedAt (excluded from "current" per AC-13/AC-14); the old version's rotationLockedAt is
 *  cleared, restoring it as "current" and once again subject to normal retention rules. */
export async function abandonRotation(
  tx: Tx,
  params: { orgId: string; projectId: string; credentialId: string; rotationId: string }
): Promise<AbandonRotationResult> {
  const lockResult = await acquireAndLoadStaleRotation(tx, params)
  if (lockResult.outcome !== 'ok') return lockResult

  const transition = await transitionOutOfStaleRecovery(
    tx,
    params,
    lockResult.rotation.version,
    'abandoned'
  )
  if (transition.outcome !== 'ok') return transition
  const updated = transition.rotation

  await tx
    .update(credentialVersions)
    .set({ abandonedAt: new Date() })
    .where(eq(credentialVersions.id, updated.newVersionId))
  await tx
    .update(credentialVersions)
    .set({ rotationLockedAt: null })
    .where(eq(credentialVersions.id, updated.previousVersionId))

  const checklistItems = await tx
    .select()
    .from(rotationChecklistItems)
    .where(eq(rotationChecklistItems.rotationId, params.rotationId))
    .orderBy(asc(rotationChecklistItems.createdAt), asc(rotationChecklistItems.id))

  return { outcome: 'abandoned', rotation: updated, checklistItems }
}

export function serializeUpcomingRotation(item: UpcomingRotationResult) {
  return {
    credentialId: item.credentialId,
    credentialName: item.credentialName,
    scheduledAt: item.nextDueAt.toISOString(),
    status: item.status,
  }
}

/** GET /api/v1/projects/:projectId/rotations/upcoming (FR65/AC-14) */
export async function getUpcomingRotations(
  tx: Tx,
  params: { projectId: string; horizonDays: number }
): Promise<ReturnType<typeof serializeUpcomingRotation>[]> {
  const results = await computeUpcomingRotations(tx, {
    projectId: params.projectId,
    horizonDays: params.horizonDays,
  })
  return results.map(serializeUpcomingRotation)
}
