import { createHash, timingSafeEqual } from 'node:crypto'
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm'
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
import { nextCronOccurrence, normalizeFieldKey } from '@project-vault/shared'
import { env } from '../../config/env.js'
import { encryptValue } from '../../lib/encrypt-value.js'
import { zeroOverwriteCredentialVersionValue } from '../../lib/zero-overwrite-credential-version.js'
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
import {
  fieldMetaForResponse,
  parseFieldsFromPlaintext,
  serializeFieldEnvelope,
  unwrapRevealValue,
} from '../credentials/field-set.js'
import type {
  BreakGlassRotationBody,
  CompleteRotationBody,
  ConfirmChecklistItemBody,
  FailChecklistItemBody,
  InitiateRotationBody,
  ListRotationsQuery,
  PromoteRotationBody,
  RetireRotationBody,
} from './schema.js'

export class RotationConflictError extends Error {
  constructor(public readonly rotationId: string | null) {
    super('A rotation is already in progress for this credential.')
  }
}

type ChecklistItemRow = typeof rotationChecklistItems.$inferSelect
type RotationRow = typeof rotations.$inferSelect

// Story 5.6 AC-2.6/AC-10.1: the widened "active rotation" status set — kept in sync with
// idx_rotations_one_active_per_credential's predicate (packages/db/src/schema/rotations.ts) and
// archive-guards.ts's BLOCKING_ROTATION_STATUSES by all three referencing the same shape,
// wherever the layering allows a literal shared import (DB schema/migration SQL can't import
// from apps/api, so that one stays a hand-kept-in-sync literal — flagged there).
export const ACTIVE_ROTATION_STATUSES = ['in_progress', 'staged', 'promoted', 'stale_recovery']

export type InitiateRotationResult =
  | { status: 'credential_not_found' }
  | { status: 'project_archived' }
  // Story 13.4 AC-3: a targetFields entry that doesn't exist on the credential's current
  // field_meta. Returned before any write.
  | { status: 'unknown_field_key'; field: string }
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

// Story 5.6 AC-2.2: new rotations insert as 'staged' (was 'in_progress') — this lookup (used to
// report "who won" in a 409 rotation_in_progress response) must match the widened active set,
// not just the legacy status value, or the loser of a race gets rotationId: null.
async function findInProgressRotationId(tx: Tx, credentialId: string): Promise<string | null> {
  const [row] = await tx
    .select({ id: rotations.id })
    .from(rotations)
    .where(
      and(
        eq(rotations.credentialId, credentialId),
        inArray(rotations.status, ACTIVE_ROTATION_STATUSES)
      )
    )
    .limit(1)
  return row?.id ?? null
}

// Story 13.4 AC-3 — extracted purely to keep initiateRotation()'s transaction callback under
// this project's complexity ceiling. Normalizes targetFields and validates every key exists
// against the credential's CURRENT field_meta (passed in from inside the same locked
// transaction, never a stale client-side snapshot). `normalized: undefined` means whole-secret
// rotation (targetFields was absent).
type TargetFieldsValidation =
  { ok: true; normalized: string[] | undefined } | { ok: false; field: string }

function validateTargetFields(
  targetFields: string[] | undefined,
  schemaVersion: number,
  fieldMeta: unknown
): TargetFieldsValidation {
  if (!targetFields) return { ok: true, normalized: undefined }
  const normalized = targetFields.map((key) => normalizeFieldKey(key))
  const declaredKeys = fieldMetaForResponse(schemaVersion, fieldMeta).map((f) =>
    normalizeFieldKey(f.key)
  )
  const missing = normalized.find((key) => !declaredKeys.includes(key))
  if (missing !== undefined) return { ok: false, field: missing }
  return { ok: true, normalized }
}

// Story 13.4 AC-5/AC-8 — extracted for the same complexity-ceiling reason as
// validateTargetFields above. Builds the new version's full field-set snapshot (targeted
// field(s) substituted, every other field carried over unchanged from the SAME decrypted read),
// and reports whether the targeted field(s) already held `newValue` (for the sameValueAsPrevious
// warning). A decrypt failure upstream of this call (in withSecret) already aborts the whole
// trx.transaction() atomically — this function only ever runs against an already-decrypted
// plaintext.
function buildFieldScopedSnapshot(
  previousSchemaVersion: number,
  previousPlaintext: string,
  normalizedTargetFields: string[],
  newValue: string
): { fields: ReturnType<typeof parseFieldsFromPlaintext>; sameValueAsPrevious: boolean } {
  const previousFields = parseFieldsFromPlaintext(previousSchemaVersion, previousPlaintext)
  const targetSet = new Set(normalizedTargetFields)
  const nextFields = previousFields.map((f) =>
    targetSet.has(normalizeFieldKey(f.key)) ? { ...f, value: newValue } : f
  )
  const sameValueAsPrevious = normalizedTargetFields.every((key) => {
    const match = previousFields.find((f) => normalizeFieldKey(f.key) === key)
    return match !== undefined && constantTimeEqual(match.value, newValue)
  })
  return { fields: nextFields, sameValueAsPrevious }
}

type PreviousVersionRow = {
  encryptedValue: unknown
  schemaVersion: number
  fieldMeta: unknown
}

// Story 13.4 — extracted for the same complexity-ceiling reason as the two helpers above: decrypts
// the previous version (when present) and computes whether the rotation's newValue is identical
// to what's already stored — field-scoped compares only the targeted field(s) (AC-5), whole-secret
// compares the single unwrapped value (unchanged, pre-13.4 behavior). Returns the decrypted
// plaintext too, so the caller building the new version's snapshot doesn't decrypt twice.
async function computeSameValueAsPrevious(
  previousVersion: PreviousVersionRow,
  normalizedTargetFields: string[] | undefined,
  newValue: string
): Promise<{ sameValueAsPrevious: boolean; previousPlaintext: string | undefined }> {
  if (!previousVersion.encryptedValue) {
    return { sameValueAsPrevious: false, previousPlaintext: undefined }
  }
  const previousPlaintext = await withSecret(
    previousVersion.encryptedValue as Parameters<typeof withSecret>[0],
    (plaintext) => Promise.resolve(plaintext.toString('utf8'))
  )
  if (normalizedTargetFields) {
    // AC-5/AC-8: a decrypt failure above already aborted the whole trx.transaction() atomically —
    // this only ever runs against an already-decrypted plaintext.
    const { sameValueAsPrevious } = buildFieldScopedSnapshot(
      previousVersion.schemaVersion,
      previousPlaintext,
      normalizedTargetFields,
      newValue
    )
    return { sameValueAsPrevious, previousPlaintext }
  }
  // Story 13.2 — a single-value secret is now stored as a schema_version = 2 field envelope;
  // unwrap it back to the bare value before the same-value comparison (legacy schema_version = 1
  // rows return the bare string unchanged).
  const previousValue = unwrapRevealValue(previousVersion.schemaVersion, previousPlaintext)
  return { sameValueAsPrevious: constantTimeEqual(previousValue, newValue), previousPlaintext }
}

// Story 13.4 AC-5 (Dev Notes — "Promote vs. retire: where the field-set snapshot lands"): field
// substitution happens HERE, at initiation, not at promote/retire — the new version already
// contains a full field-set snapshot (FR12) the moment it's created. Whole-secret rotation
// (normalizedTargetFields undefined) keeps today's existing single-value replacement behavior,
// byte-identical, per AC-7. Extracted for the same complexity-ceiling reason as the helpers above.
async function buildNewVersionInsertFields(
  previousVersion: PreviousVersionRow,
  previousPlaintext: string | undefined,
  normalizedTargetFields: string[] | undefined,
  newValue: string
): Promise<{
  encryptedValue: Awaited<ReturnType<typeof encryptValue>>
  schemaVersion?: number
  fieldMeta?: unknown
}> {
  if (!normalizedTargetFields) {
    return { encryptedValue: await encryptValue(newValue) }
  }
  const snapshot = buildFieldScopedSnapshot(
    previousVersion.schemaVersion,
    previousPlaintext ?? '',
    normalizedTargetFields,
    newValue
  )
  return {
    encryptedValue: await encryptValue(serializeFieldEnvelope({ fields: snapshot.fields })),
    schemaVersion: 2,
    // Field structure (keys/sensitivity/template) never changes on rotation — carried over
    // unchanged, materialized in case the previous version was legacy (schemaVersion < 2) and had
    // no real field_meta row to copy.
    fieldMeta: fieldMetaForResponse(previousVersion.schemaVersion, previousVersion.fieldMeta),
  }
}

// Story 13.4 — extracted purely to keep initiateRotation()'s transaction callback under this
// project's complexity ceiling. Builds the new credential_versions insert values, including the
// two optional (undefined-when-whole-secret) schemaVersion/fieldMeta overrides from
// buildNewVersionInsertFields().
function newVersionInsertValues(
  input: { orgId: string; credentialId: string; userId: string },
  previousVersion: { versionNumber: number },
  keyVersion: number,
  newVersionFields: {
    encryptedValue: Awaited<ReturnType<typeof encryptValue>>
    schemaVersion?: number
    fieldMeta?: unknown
  }
) {
  return {
    orgId: input.orgId,
    credentialId: input.credentialId,
    encryptedValue: newVersionFields.encryptedValue,
    keyVersion,
    versionNumber: previousVersion.versionNumber + 1,
    createdBy: input.userId,
    ...(newVersionFields.schemaVersion !== undefined
      ? { schemaVersion: newVersionFields.schemaVersion }
      : {}),
    ...(newVersionFields.fieldMeta !== undefined ? { fieldMeta: newVersionFields.fieldMeta } : {}),
  }
}

// Story 13.4 AC-4 — extracted for the same complexity-ceiling reason as the helper above. When
// this is a field-scoped rotation, the checklist snapshot only includes whole-credential
// dependencies (field_key IS NULL) plus dependencies scoped to a targeted field. Whole-secret
// rotation (normalizedTargetFields undefined) keeps today's existing unfiltered query, unchanged.
function dependencyChecklistFilter(
  orgId: string,
  credentialId: string,
  normalizedTargetFields: string[] | undefined
) {
  return and(
    eq(credentialDependencies.orgId, orgId),
    eq(credentialDependencies.credentialId, credentialId),
    isNull(credentialDependencies.archivedAt),
    normalizedTargetFields
      ? or(
          isNull(credentialDependencies.fieldKey),
          inArray(credentialDependencies.fieldKey, normalizedTargetFields)
        )
      : undefined
  )
}

type LoadRotationTargetResult =
  | { status: 'credential_not_found' }
  | { status: 'project_archived' }
  | { status: 'ok'; previousVersion: PreviousVersionRow & { id: string; versionNumber: number } }

// Story 13.4 — shared by both call sites that need to lock "the current version to supersede"
// (normal initiation below, and break-glass's createBreakGlassVersion further down): same FOR
// UPDATE query, ordering, and not-found guard, previously duplicated inline at each site (flagged
// as a code clone). Always excludes abandonedAt: without it, a staged-then-abandoned rotation
// (Story 5.6 AC-2.5 — abandon does not purge, it only sets abandonedAt) can still have the highest
// versionNumber and would be selected as "the version to supersede". Pre-13.4 this only skewed
// versionNumber/the same-value flag (cosmetic); since this story's field-scoped rotation carries
// this row's DECRYPTED CONTENT into the new version's non-targeted fields
// (buildFieldScopedSnapshot), picking an abandoned version would silently resurrect secret
// material that was deliberately never promoted.
async function lockCurrentNonPurgedVersion(
  tx: Tx,
  credentialId: string,
  notFoundMessage: string
): Promise<PreviousVersionRow & { id: string; versionNumber: number }> {
  const [row] = await tx
    .select({
      id: credentialVersions.id,
      versionNumber: credentialVersions.versionNumber,
      encryptedValue: credentialVersions.encryptedValue,
      schemaVersion: credentialVersions.schemaVersion,
      fieldMeta: credentialVersions.fieldMeta,
    })
    .from(credentialVersions)
    .where(
      and(
        eq(credentialVersions.credentialId, credentialId),
        isNull(credentialVersions.purgedAt),
        isNull(credentialVersions.abandonedAt)
      )
    )
    .orderBy(desc(credentialVersions.versionNumber))
    .for('update')
    .limit(1)
  if (!row) {
    throw new Error(notFoundMessage)
  }
  return row
}

// Story 13.4 — extracted purely to keep initiateRotation()'s transaction callback under this
// project's complexity ceiling; behavior unchanged from the pre-13.4 inline version. Locks the
// project row (Story 5.5 AC-1's TOCTOU-closing `FOR UPDATE`), the credential row, and the
// current non-purged version row, in that order, inside the same transaction the caller already
// holds — every lock this function takes is released only when the outer transaction commits or
// rolls back.
async function loadRotationTargetForUpdate(
  trx: Tx,
  input: { orgId: string; projectId: string; credentialId: string }
): Promise<LoadRotationTargetResult> {
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
  if (!projectRow) return { status: 'credential_not_found' }
  if (projectRow.archivedAt !== null) return { status: 'project_archived' }

  const credential = await lockCredentialInProject(trx, {
    credentialId: input.credentialId,
    projectId: input.projectId,
  })
  if (!credential) return { status: 'credential_not_found' }

  const previousVersion = await lockCurrentNonPurgedVersion(
    trx,
    input.credentialId,
    `initiateRotation: credential ${input.credentialId} has no non-purged version to supersede`
  )
  return { status: 'ok', previousVersion }
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
      const loaded = await loadRotationTargetForUpdate(trx, input)
      if (loaded.status !== 'ok') return loaded
      const { previousVersion } = loaded

      // Story 13.4 AC-2/AC-3: validation happens before any write, against the credential's
      // CURRENT field_meta (loaded above inside this same locked transaction).
      const validation = validateTargetFields(
        input.body.targetFields,
        previousVersion.schemaVersion,
        previousVersion.fieldMeta
      )
      if (!validation.ok) {
        return { status: 'unknown_field_key' as const, field: validation.field }
      }
      const normalizedTargetFields = validation.normalized

      const { sameValueAsPrevious, previousPlaintext } = await computeSameValueAsPrevious(
        previousVersion,
        normalizedTargetFields,
        input.body.newValue
      )

      const keyVersion = await currentKeyVersion(trx)
      const newVersionFields = await buildNewVersionInsertFields(
        previousVersion,
        previousPlaintext,
        normalizedTargetFields,
        input.body.newValue
      )

      const [newVersion] = await trx
        .insert(credentialVersions)
        .values(newVersionInsertValues(input, previousVersion, keyVersion, newVersionFields))
        .returning()
      if (!newVersion)
        throw new Error('initiateRotation: new credential version insert returned no row')

      await trx
        .update(credentialVersions)
        .set({ rotationLockedAt: new Date() })
        .where(eq(credentialVersions.id, previousVersion.id))

      // Story 13.4 AC-4: when this is a field-scoped rotation, the checklist snapshot only
      // includes whole-credential dependencies (field_key IS NULL) plus dependencies scoped to a
      // targeted field. Whole-secret rotation (normalizedTargetFields undefined) keeps today's
      // existing unfiltered query, unchanged.
      const dependencyRows = await trx
        .select({ id: credentialDependencies.id, systemName: credentialDependencies.systemName })
        .from(credentialDependencies)
        .where(dependencyChecklistFilter(input.orgId, input.credentialId, normalizedTargetFields))

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
          targetFields: normalizedTargetFields ?? null,
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
    // Story 13.4 AC-2/AC-7: always present (array when field-scoped, null for whole-secret) —
    // never omitted, so clients don't need a second undefined/absent branch.
    targetFields: rotation.targetFields ?? null,
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

type ConcurrentModificationResult = {
  outcome: 'concurrent_modification'
  currentVersion: number | null
}

/** Shared by completeRotation/promoteRotation/retireRotation's terminal CAS transition: a single
 *  `UPDATE ... WHERE id = ... AND version = observedVersion` that both performs the status
 *  transition (whatever `setFields` says) and bumps the optimistic-lock version, so a lost race
 *  (version mismatch) simply returns zero rows — no separate version-only UPDATE needed. Returns
 *  the updated row, or the `concurrent_modification` outcome (re-reading the current version) if
 *  the CAS lost. */
/** `fromStatus` is an optional extra CAS guard (resume/abandon transition FROM a specific
 *  status, e.g. `stale_recovery`) — omitted for completeRotation/promoteRotation/retireRotation,
 *  which already guard status via their own acquireAndLoad* preamble before ever reaching here. */
async function casTransitionRotation(
  tx: Tx,
  params: { projectId: string; credentialId: string; rotationId: string },
  observedVersion: number,
  setFields: Partial<typeof rotations.$inferInsert>,
  fromStatus?: string
): Promise<{ outcome: 'ok'; rotation: RotationRow } | ConcurrentModificationResult> {
  const [updated] = await tx
    .update(rotations)
    .set({ ...setFields, version: observedVersion + 1, updatedAt: new Date() })
    .where(
      and(
        eq(rotations.id, params.rotationId),
        eq(rotations.version, observedVersion),
        ...(fromStatus ? [eq(rotations.status, fromStatus)] : [])
      )
    )
    .returning()
  if (!updated) {
    const current = await findRotationInScope(tx, params)
    return { outcome: 'concurrent_modification', currentVersion: current?.version ?? null }
  }
  return { outcome: 'ok', rotation: updated }
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

// Story 5.6 AC-8.5/persona journey: the checklist itself (confirm/fail/retry) is workable
// throughout staged AND promoted (dependent-system owners keep confirming after promotion, up
// until retire) — a materially wider set than completeRotation's own legacy in_progress-only
// gate (AC-6.4), which is why acquireAndLoadRotation below takes the allowed-status set as a
// parameter rather than hard-coding a single status.
const CHECKLIST_ACTION_ALLOWED_STATUSES = ['in_progress', 'staged', 'promoted']

/** AC-8's uniform entry sequence for the checklist mutation endpoints (confirm/fail/retry) AND
 *  (with its default) the legacy `complete` route. `allowedStatuses` defaults to legacy
 *  `in_progress`-only for completeRotation's own unchanged gate (AC-6.4) — confirm/fail/retry
 *  pass CHECKLIST_ACTION_ALLOWED_STATUSES instead. */
async function acquireAndLoadRotation(
  tx: Tx,
  params: { orgId: string; projectId: string; credentialId: string; rotationId: string },
  allowedStatuses: string[] = ['in_progress']
): Promise<RotationLockOutcome> {
  const result = await acquireRotationScopedLockAndFind(tx, params)
  if (result.outcome !== 'found') return result
  if (!allowedStatuses.includes(result.rotation.status)) {
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
  const lockResult = await acquireAndLoadRotation(tx, params, CHECKLIST_ACTION_ALLOWED_STATUSES)
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
  // Story 5.6 AC-6.4: the legacy `complete` route is reachable ONLY for still-in_progress
  // rotations — a staged/promoted/retired rotation gets this distinct 409, not the generic
  // 422 rotation_not_active (which is kept, unchanged, for the other terminal statuses).
  | { outcome: 'rotation_wrong_state_for_legacy_complete'; currentStatus: string }
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

// Story 5.6 AC-6.4: statuses for which the legacy `complete` route must return the new
// rotation_wrong_state_for_legacy_complete 409 instead of the generic rotation_not_active 422 —
// every OTHER non-in_progress status (completed/abandoned/stale_recovery/break_glass_complete)
// keeps the unchanged legacy 422 behavior.
const LEGACY_COMPLETE_BLOCKED_STATUSES = new Set(['staged', 'promoted', 'retired'])

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
  // AC-6.4: check this BEFORE the generic lockOutcomeToFailure mapping — staged/promoted/
  // retired rotations get the new 409 code, not the legacy 422 rotation_not_active shape.
  if (
    lockResult.outcome === 'not_active' &&
    LEGACY_COMPLETE_BLOCKED_STATUSES.has(lockResult.rotation.status)
  ) {
    return {
      outcome: 'rotation_wrong_state_for_legacy_complete',
      currentStatus: lockResult.rotation.status,
    }
  }
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
  const transition = await casTransitionRotation(tx, params, lockResult.rotation.version, {
    status: 'completed',
    completedAt: new Date(),
  })
  if (transition.outcome !== 'ok') return transition
  const updatedRotation = transition.rotation

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

// ============================================================================
// Story 5.6 — staged -> promoted -> retired: promote, retire, staged-value reveal
// ============================================================================

type StagedPromotedLockOutcome<TWrongStatusOutcome extends string> =
  | { outcome: 'locked_conflict'; currentVersion: number | null }
  | { outcome: 'rotation_not_found' }
  | { outcome: TWrongStatusOutcome; currentStatus: string }
  | { outcome: 'ok'; rotation: RotationRow }

/** AC-5.1: shared entry sequence for promote/retire — acquire the rotation-scoped advisory
 *  lock (same key domain as every other rotation mutation, AC-5.1), then require the rotation's
 *  status to be EXACTLY `expectedStatus`, mapping any other status to the caller's own
 *  operation-specific "not promotable"/"not retirable" outcome (Example 2a/2b). */
async function acquireAndLoadRotationExpecting<TWrongStatusOutcome extends string>(
  tx: Tx,
  params: { orgId: string; projectId: string; credentialId: string; rotationId: string },
  expectedStatus: string,
  wrongStatusOutcome: TWrongStatusOutcome
): Promise<StagedPromotedLockOutcome<TWrongStatusOutcome>> {
  const result = await acquireRotationScopedLockAndFind(tx, params)
  if (result.outcome === 'locked_conflict') return result
  if (result.outcome === 'not_found') return { outcome: 'rotation_not_found' }
  if (result.rotation.status !== expectedStatus) {
    return { outcome: wrongStatusOutcome, currentStatus: result.rotation.status }
  }
  return { outcome: 'ok', rotation: result.rotation }
}

type ChecklistAcknowledgementOutcome =
  | {
      outcome: 'acknowledgement_required'
      pendingItems: { id: string; systemName: string; status: string }[]
      totalItemCount: number
    }
  | { outcome: 'ok'; checklistAcknowledged: boolean; pendingCount: number }

/** AC-6.1/AC-6.2: shared advisory-checklist acknowledgement gate for promote/retire — computed
 *  FRESH from the current checklist state every call (AC-8.5: acknowledging at promote time
 *  never carries forward to retire time, and vice versa). Zero items still requires the
 *  existing acknowledgedNoDependencies flag (unchanged semantics); non-zero pending items
 *  require the new acknowledgeIncompleteChecklist flag instead of hard-blocking. */
function evaluateChecklistAcknowledgement(
  items: ChecklistItemRow[],
  body: { acknowledgedNoDependencies?: boolean; acknowledgeIncompleteChecklist?: boolean }
): ChecklistAcknowledgementOutcome {
  const pending = items.filter((item) => item.status !== 'confirmed')
  if (items.length === 0) {
    if (body.acknowledgedNoDependencies !== true) {
      return { outcome: 'acknowledgement_required', pendingItems: [], totalItemCount: 0 }
    }
    return { outcome: 'ok', checklistAcknowledged: false, pendingCount: 0 }
  }
  if (pending.length > 0) {
    if (body.acknowledgeIncompleteChecklist !== true) {
      return {
        outcome: 'acknowledgement_required',
        pendingItems: pending.map((item) => ({
          id: item.id,
          systemName: item.systemName,
          status: item.status,
        })),
        totalItemCount: items.length,
      }
    }
    return { outcome: 'ok', checklistAcknowledged: true, pendingCount: pending.length }
  }
  // Fully confirmed — Example 6b: no acknowledgement needed or given.
  return { outcome: 'ok', checklistAcknowledged: false, pendingCount: 0 }
}

async function loadChecklistItems(tx: Tx, rotationId: string): Promise<ChecklistItemRow[]> {
  return tx
    .select()
    .from(rotationChecklistItems)
    .where(eq(rotationChecklistItems.rotationId, rotationId))
    .orderBy(asc(rotationChecklistItems.createdAt), asc(rotationChecklistItems.id))
}

type ReadyToTransition = {
  outcome: 'ready'
  rotation: RotationRow
  items: ChecklistItemRow[]
  checklistAcknowledged: boolean
  pendingCount: number
}

/** Shared preamble for promoteRotation/retireRotation: acquire-and-status-check the rotation
 *  (AC-5.1), then evaluate the AC-6 advisory-checklist acknowledgement gate against a FRESH read
 *  of the checklist (AC-8.5 — never carried over between promote and retire). Collapses both
 *  functions' identical early-return plumbing into one call. */
async function acquireLoadAndAcknowledgeRotation<TWrongStatusOutcome extends string>(
  tx: Tx,
  params: {
    orgId: string
    projectId: string
    credentialId: string
    rotationId: string
    body: { acknowledgedNoDependencies?: boolean; acknowledgeIncompleteChecklist?: boolean }
  },
  expectedStatus: string,
  wrongStatusOutcome: TWrongStatusOutcome
): Promise<
  | Exclude<StagedPromotedLockOutcome<TWrongStatusOutcome>, { outcome: 'ok' }>
  | {
      outcome: 'acknowledgement_required'
      pendingItems: { id: string; systemName: string; status: string }[]
      totalItemCount: number
    }
  | ReadyToTransition
> {
  const lockResult = await acquireAndLoadRotationExpecting(
    tx,
    params,
    expectedStatus,
    wrongStatusOutcome
  )
  if (lockResult.outcome !== 'ok') {
    return lockResult as Exclude<StagedPromotedLockOutcome<TWrongStatusOutcome>, { outcome: 'ok' }>
  }
  const rotation = (lockResult as { outcome: 'ok'; rotation: RotationRow }).rotation

  const items = await loadChecklistItems(tx, params.rotationId)
  const ack = evaluateChecklistAcknowledgement(items, params.body)
  if (ack.outcome === 'acknowledgement_required') return ack

  return {
    outcome: 'ready',
    rotation,
    items,
    checklistAcknowledged: ack.checklistAcknowledged,
    pendingCount: ack.pendingCount,
  }
}

export type PromoteRotationResult =
  | { outcome: 'locked_conflict'; currentVersion: number | null }
  | { outcome: 'rotation_not_found' }
  | { outcome: 'rotation_not_promotable'; currentStatus: string }
  | {
      outcome: 'acknowledgement_required'
      pendingItems: { id: string; systemName: string; status: string }[]
      totalItemCount: number
    }
  | { outcome: 'concurrent_modification'; currentVersion: number | null }
  | {
      outcome: 'promoted'
      rotation: RotationRow
      checklistItems: ChecklistItemRow[]
      checklistAcknowledged: boolean
      pendingItemCountAtAction: number
    }

/** AC-2.3/AC-5/AC-6: staged -> promoted. Atomic (AC-5.5): the CAS status-transition UPDATE and
 *  the credential_versions.promoted_at flip both happen inside this same transaction as the
 *  caller's acquireRotationScopedLockAndFind lock acquisition — the ROTATION_PROMOTED audit
 *  write itself happens one layer up, in routes.ts, sharing the identical transaction (the
 *  route handler never commits/re-opens a transaction mid-request), so a failed audit write
 *  still rolls back this function's DB writes too. */
export async function promoteRotation(
  tx: Tx,
  params: {
    orgId: string
    projectId: string
    credentialId: string
    rotationId: string
    userId: string
    body: PromoteRotationBody
  }
): Promise<PromoteRotationResult> {
  const ready = await acquireLoadAndAcknowledgeRotation(
    tx,
    params,
    'staged',
    'rotation_not_promotable' as const
  )
  if (ready.outcome !== 'ready') return ready

  const transition = await casTransitionRotation(tx, params, ready.rotation.version, {
    status: 'promoted',
    promotedAt: new Date(),
  })
  if (transition.outcome !== 'ok') return transition
  const updatedRotation = transition.rotation

  // AC-1: flips the promoted (new) version's current-selection eligibility.
  await tx
    .update(credentialVersions)
    .set({ promotedAt: new Date() })
    .where(eq(credentialVersions.id, updatedRotation.newVersionId))

  return {
    outcome: 'promoted',
    rotation: updatedRotation,
    checklistItems: ready.items,
    checklistAcknowledged: ready.checklistAcknowledged,
    pendingItemCountAtAction: ready.pendingCount,
  }
}

export type RetireRotationResult =
  | { outcome: 'locked_conflict'; currentVersion: number | null }
  | { outcome: 'rotation_not_found' }
  | { outcome: 'rotation_not_retirable'; currentStatus: string }
  | {
      outcome: 'acknowledgement_required'
      pendingItems: { id: string; systemName: string; status: string }[]
      totalItemCount: number
    }
  | { outcome: 'concurrent_modification'; currentVersion: number | null }
  | {
      outcome: 'retired'
      rotation: RotationRow
      checklistItems: ChecklistItemRow[]
      checklistAcknowledged: boolean
      pendingItemCountAtAction: number
    }

/** AC-2.4/AC-3.1: promoted -> retired. Cryptographically purges the previous (old) version
 *  (same zero-then-null pattern as prune-credential-versions.ts's purgeVersion — AC-5.3's
 *  double-purge safety: both UPDATEs are guarded by `purgedAt IS NULL`, a safe no-op if this
 *  version was somehow already purged) and clears rotationLockedAt (AC-3.1 — the FR105
 *  exemption now clears HERE, not at promote). All in the same transaction as the status
 *  transition, same atomicity property as promoteRotation above. */
export async function retireRotation(
  tx: Tx,
  params: {
    orgId: string
    projectId: string
    credentialId: string
    rotationId: string
    userId: string
    body: RetireRotationBody
  }
): Promise<RetireRotationResult> {
  // AC-8.5: acquireLoadAndAcknowledgeRotation computes the checklist acknowledgement FRESH at
  // retire time — independent of whatever was true at promote time.
  const ready = await acquireLoadAndAcknowledgeRotation(
    tx,
    params,
    'promoted',
    'rotation_not_retirable' as const
  )
  if (ready.outcome !== 'ready') return ready

  const transition = await casTransitionRotation(tx, params, ready.rotation.version, {
    status: 'retired',
    retiredAt: new Date(),
  })
  if (transition.outcome !== 'ok') return transition
  const updatedRotation = transition.rotation

  const oldVersionId = updatedRotation.previousVersionId
  // Matches prune-credential-versions.ts's purgeVersion exactly (see
  // zeroOverwriteCredentialVersionValue's doc comment). Both steps re-check `purgedAt IS NULL`
  // so a concurrent double-purge attempt (AC-5.3/AC-5.4) is a safe no-op, not an error.
  await zeroOverwriteCredentialVersionValue(tx, oldVersionId, isNull(credentialVersions.purgedAt))
  await tx
    .update(credentialVersions)
    .set({ encryptedValue: null, keyVersion: null, purgedAt: new Date(), rotationLockedAt: null })
    .where(and(eq(credentialVersions.id, oldVersionId), isNull(credentialVersions.purgedAt)))

  return {
    outcome: 'retired',
    rotation: updatedRotation,
    checklistItems: ready.items,
    checklistAcknowledged: ready.checklistAcknowledged,
    pendingItemCountAtAction: ready.pendingCount,
  }
}

export type GetStagedValueResult =
  | { status: 'rotation_not_found' }
  | { status: 'not_staged'; currentStatus: string }
  | { status: 'found'; value: string; versionNumber: number }

/** AC-8: independently-retrievable staged value — reads OUTSIDE the rotation-scoped advisory
 *  lock (a read, not a mutation, matching the ordinary value-reveal route's pattern), but
 *  re-checks `status === 'staged'` as part of its own read (AC-5.6) so a reveal racing a
 *  concurrent abandon/promote never serves a stale, no-longer-staged value. */
export async function getStagedValue(
  tx: Tx,
  params: { projectId: string; credentialId: string; rotationId: string }
): Promise<GetStagedValueResult> {
  const rotation = await findRotationInScope(tx, params)
  if (!rotation) return { status: 'rotation_not_found' }
  if (rotation.status !== 'staged') {
    return { status: 'not_staged', currentStatus: rotation.status }
  }

  // Review fix (5-6 code review, AC-5.6): the `rotation.status !== 'staged'` check above and
  // this version fetch are two separate statements with no lock between them (this route
  // deliberately does not take the rotation-scoped advisory lock, since it's a read — see
  // AC-5.6's rationale). Without `isNull(abandonedAt)` here, a concurrent abandon (either the
  // ordinary abandonRotation() or break-glass's supersedeActiveRotation(), both of which set
  // credentialVersions.abandonedAt on this exact row in the same transaction they flip
  // rotations.status away from 'staged') could commit in the narrow window between the two
  // statements above, and this query — reading only by id, with no re-check of abandonment —
  // would still return the now-abandoned version's plaintext. Filtering on abandonedAt here
  // closes that window using the same idiom `revealCurrentValue()`'s current-version query
  // already relies on (CR5) for the identical purpose.
  const [version] = await tx
    .select({
      versionNumber: credentialVersions.versionNumber,
      encryptedValue: credentialVersions.encryptedValue,
      schemaVersion: credentialVersions.schemaVersion,
    })
    .from(credentialVersions)
    .where(
      and(eq(credentialVersions.id, rotation.newVersionId), isNull(credentialVersions.abandonedAt))
    )
    .limit(1)
  if (!version?.encryptedValue) return { status: 'rotation_not_found' }

  const plaintext = await withSecret(version.encryptedValue, async (buf) => buf.toString('utf8'))
  const value = unwrapRevealValue(version.schemaVersion, plaintext)
  return { status: 'found', value, versionNumber: version.versionNumber }
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
    if (ACTIVE_ROTATION_STATUSES.includes(row.status)) {
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
  | { status: 'promoted_rotation_conflict'; rotationId: string }
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

/** Thrown by {@link supersedeActiveRotation} when the credential already has a
 *  promoted-but-unretired rotation — see that function's doc comment. Caught by
 *  {@link breakGlassRotation} and mapped to a 409 `promoted_rotation_conflict` rather than
 *  letting break-glass proceed and silently displace the live value. */
class PromotedRotationConflictError extends Error {
  constructor(public readonly rotationId: string) {
    super(`credential has a promoted-but-unretired rotation ${rotationId}`)
  }
}

/** AC-5/CR6, widened by Story 5.6: if an existing rotation is `in_progress`, `staged`, or
 *  `stale_recovery` for this credential, abandon it (identical mechanics to the manual `abandon`
 *  endpoint, AC-12) before break-glass inserts its own rotation row. `staged` is included because
 *  its new version is, like `in_progress`'s, not yet "current" — abandoning it is exactly as safe
 *  as abandoning an in_progress rotation was pre-5.6. A `promoted`-but-unretired rotation is
 *  handled differently: its new version IS the current, live value, so silently abandoning it
 *  here would un-serve a value dependent systems may already be using. Rather than proceeding
 *  around it (the pre-hardening behavior, which let break-glass's own later `promoted_at` win and
 *  silently orphan the earlier promoted rotation), this hard-blocks by throwing
 *  {@link PromotedRotationConflictError} — the caller must promote/retire/abandon the existing
 *  rotation first. `FOR UPDATE NOWAIT` (not a blocking read) is deliberate — see AC-5/AC-6: a
 *  concurrent 5.2 confirm/fail/retry/complete call holds a *rotation*-scoped advisory lock, a
 *  different key domain break-glass's *credential*-scoped lock never serializes against, so a
 *  blocking row-lock read here could silently stall break-glass behind an unrelated in-flight
 *  human action — defeating its "act in seconds" premise. Returns the superseded rotation's id,
 *  or null if there was nothing active to supersede. Throws (for the caller to map to 409
 *  rotation_lock_contention) if the NOWAIT lock acquisition fails. */
async function supersedeActiveRotation(
  tx: Tx,
  params: { orgId: string; credentialId: string }
): Promise<string | null> {
  const [active] = await tx
    .select({
      id: rotations.id,
      version: rotations.version,
      status: rotations.status,
      newVersionId: rotations.newVersionId,
      previousVersionId: rotations.previousVersionId,
    })
    .from(rotations)
    .where(
      and(
        eq(rotations.credentialId, params.credentialId),
        inArray(rotations.status, ['in_progress', 'staged', 'stale_recovery', 'promoted'])
      )
    )
    .for('update', { noWait: true })
    .limit(1)
  if (!active) return null
  if (active.status === 'promoted') throw new PromotedRotationConflictError(active.id)

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
  const previousVersion = await lockCurrentNonPurgedVersion(
    tx,
    input.credentialId,
    `breakGlassRotation: credential ${input.credentialId} has no non-purged/non-abandoned version to supersede`
  )

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
  // Story 5.6 AC-9.1: within this single transaction, the new version is created as a literal
  // `staged` moment (promotedAt starts unset) then immediately promoted (promotedAt = NOW()) —
  // satisfying "still creates a staged version, then instantly promotes it" literally, not just
  // conceptually. Written as one INSERT with promotedAt already set (rather than two statements)
  // since no other transaction can observe the intermediate NULL state either way.
  const [newVersion] = await tx
    .insert(credentialVersions)
    .values({
      orgId: input.orgId,
      credentialId: input.credentialId,
      encryptedValue,
      keyVersion,
      versionNumber: nextVersionNumber,
      createdBy: input.userId,
      promotedAt: new Date(),
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
    if (error instanceof PromotedRotationConflictError) {
      return { status: 'promoted_rotation_conflict', rotationId: error.rotationId }
    }
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
 *  preserved" per epics.md; no additional item mutation happens on resume. Reuses the shared
 *  casTransitionRotation() helper (AC-11/AC-12/AC-15) with the `fromStatus: 'stale_recovery'`
 *  guard — resume and abandon both leave stale_recovery via an identical UPDATE...RETURNING
 *  shape, differing only in the target status. A zero-row result means either a lost CAS race or
 *  (in practice, ruled out by the advisory lock held for this whole transaction) a status that
 *  changed underneath the caller — both map to the identical 409 concurrent_modification. */
export async function resumeRotation(
  tx: Tx,
  params: { orgId: string; projectId: string; credentialId: string; rotationId: string }
): Promise<ResumeRotationResult> {
  const lockResult = await acquireAndLoadStaleRotation(tx, params)
  if (lockResult.outcome !== 'ok') return lockResult

  const transition = await casTransitionRotation(
    tx,
    params,
    lockResult.rotation.version,
    { status: 'in_progress' },
    'stale_recovery'
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
  // Story 5.6 AC-2.5: `promoted` (post-promotion, pre-retirement) is NOT abandonable via this
  // route — the only forward paths once promoted are retire, or leaving it promoted-but-
  // unretired indefinitely (FR22).
  | { outcome: 'rotation_not_abandonable_after_promotion' }
  | { outcome: 'concurrent_modification'; currentVersion: number | null }
  | { outcome: 'abandoned'; rotation: RotationRow; checklistItems: ChecklistItemRow[] }

type AbandonableLockOutcome =
  | { outcome: 'locked_conflict'; currentVersion: number | null }
  | { outcome: 'rotation_not_found' }
  | { outcome: 'rotation_not_stale'; status: string }
  | { outcome: 'rotation_not_abandonable_after_promotion' }
  | { outcome: 'ok'; rotation: RotationRow }

/** Story 5.6 AC-2.5: abandon's own status-eligibility check, distinct from
 *  acquireAndLoadStaleRotation (which resume still uses unchanged, `stale_recovery`-only) —
 *  abandon now also accepts `staged` (an unpromoted staged rotation is exactly as abandonable as
 *  an in_progress one was pre-5.6), and explicitly rejects `promoted` with its own error code
 *  before falling through to the generic "not stale" rejection for every other status. */
async function acquireAndLoadAbandonableRotation(
  tx: Tx,
  params: { orgId: string; projectId: string; credentialId: string; rotationId: string }
): Promise<AbandonableLockOutcome> {
  const result = await acquireRotationScopedLockAndFind(tx, params)
  if (result.outcome === 'locked_conflict') return result
  if (result.outcome === 'not_found') return { outcome: 'rotation_not_found' }
  if (result.rotation.status === 'promoted') {
    return { outcome: 'rotation_not_abandonable_after_promotion' }
  }
  if (result.rotation.status !== 'stale_recovery' && result.rotation.status !== 'staged') {
    return { outcome: 'rotation_not_stale', status: result.rotation.status }
  }
  return { outcome: 'ok', rotation: result.rotation }
}

/** AC-12/CR5 (Story 5.3), extended by Story 5.6 AC-2.5: stale_recovery|staged -> abandoned.
 *  Reuses the shared casTransitionRotation() helper — unlike resume (always `fromStatus:
 *  'stale_recovery'`), abandon's `fromStatus` is whichever specific status the caller was
 *  actually observed in (not just "any abandonable status"), so a status that changed underneath
 *  the caller between the lock-scoped read and this write is still caught by the CAS guard, same
 *  safety property as every other terminal transition in this file. The never-completed new
 *  version is marked abandonedAt (excluded from "current" per AC-13/AC-14); the old version's
 *  rotationLockedAt is cleared, restoring it as "current" and once again subject to normal
 *  retention rules. */
export async function abandonRotation(
  tx: Tx,
  params: { orgId: string; projectId: string; credentialId: string; rotationId: string }
): Promise<AbandonRotationResult> {
  const lockResult = await acquireAndLoadAbandonableRotation(tx, params)
  if (lockResult.outcome !== 'ok') return lockResult

  const transition = await casTransitionRotation(
    tx,
    params,
    lockResult.rotation.version,
    { status: 'abandoned' },
    lockResult.rotation.status
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
