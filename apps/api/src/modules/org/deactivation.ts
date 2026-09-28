import { and, asc, eq, gt, inArray, isNull } from 'drizzle-orm'
import type { FastifyRequest } from 'fastify'
import type { Tx } from '@project-vault/db'
import { projectInvitations, rotations } from '@project-vault/db/schema'
import type { RotationHandlingBody } from '@project-vault/shared'
import { tryAcquireRotationScopedLock } from '../../lib/rotation-locks.js'
import type { SecureRouteContext } from '../../lib/secure-route.js'
import { BLOCKING_ROTATION_STATUSES } from '../projects/archive-guards.js'
import { abandonRotation } from '../rotation/service.js'
import { writeRotationAbandonedAuditOrThrow } from '../rotation/rotation-audit.js'

/** Story 43-15 AC-8: one blocking rotation, with the scope `abandonRotation` needs to act on it. */
export type BlockingRotation = {
  id: string
  projectId: string
  credentialId: string
  status: string
}

// Story 43-15 AC-8 (Failure Mode Analysis): the explicit partition of BLOCKING_ROTATION_STATUSES
// for `rotationHandling: "abandon"`. ABANDONABLE mirrors abandonRotation's own eligibility check
// (staged/stale_recovery only); HELD is left untouched — `promoted` is post-cutover (any org admin
// retires it later, FR22) and legacy `in_progress` is moved to stale_recovery by the stale-rotation
// worker. A drift-guard test asserts the two lists partition BLOCKING_ROTATION_STATUSES exactly.
export const ABANDONABLE_ROTATION_STATUSES = ['staged', 'stale_recovery'] as const
export const HELD_ROTATION_STATUSES = ['promoted', 'in_progress'] as const

/** A blocking status in neither list above (e.g. a future `paused`) — never silently mishandled. */
export class UnhandledBlockingRotationStatusError extends Error {
  constructor(status: string) {
    super(`No rotationHandling rule for blocking rotation status '${status}'`)
    this.name = 'UnhandledBlockingRotationStatusError'
  }
}

/**
 * Story 43-15 AC-1/AC-3: the target's blocking rotations in this org — `initiated_by = userId`
 * (ownership is the initiator only, KD-2; a NULL initiator never matches), status in
 * BLOCKING_ROTATION_STATUSES, sorted by initiated_at then id so 409 bodies and tests are stable.
 * The explicit `org_id` predicate is defence in depth on top of the caller's RLS context.
 */
async function findBlockingRotationsForUser(
  tx: Tx,
  userId: string,
  orgId: string
): Promise<BlockingRotation[]> {
  return tx
    .select({
      id: rotations.id,
      projectId: rotations.projectId,
      credentialId: rotations.credentialId,
      status: rotations.status,
    })
    .from(rotations)
    .where(
      and(
        eq(rotations.orgId, orgId),
        eq(rotations.initiatedBy, userId),
        inArray(rotations.status, BLOCKING_ROTATION_STATUSES)
      )
    )
    .orderBy(asc(rotations.initiatedAt), asc(rotations.id))
}

/**
 * FR102 / Story 4.3 AC-8, completed by story 43-15: a user who still owns an unfinished rotation
 * (BLOCKING_ROTATION_STATUSES, initiated by them, in this org) cannot be deactivated or removed.
 * The caller must run this AFTER locking the target's org_memberships row FOR UPDATE and BEFORE
 * any mutation: secureRoute commits on return, so a 409 sent after a write would still commit it.
 *
 * ADR-4.4-04: the caller surfaces `rotationIds` on a 409 in the exact
 * `{ error: 'active_rotations', rotationIds }` shape the project/credential archive guards use.
 *
 * Any future writer of `org_memberships.status = 'deactivated'` (SCIM deprovisioning, dormancy
 * auto-deactivation, platform-admin actions) must call this before mutating.
 */
export async function checkActiveRotationsForUser(
  userId: string,
  orgId: string,
  tx: Tx
): Promise<{ blocked: boolean; rotationIds: string[] }> {
  const rows = await findBlockingRotationsForUser(tx, userId, orgId)
  return { blocked: rows.length > 0, rotationIds: rows.map((row) => row.id) }
}

/** Story 43-15 AC-8: splits blocking rotations into the ones to abandon and the ones to hold. */
export function partitionBlockingRotations(rows: BlockingRotation[]): {
  abandonable: BlockingRotation[]
  held: BlockingRotation[]
} {
  const abandonable: BlockingRotation[] = []
  const held: BlockingRotation[] = []
  for (const row of rows) {
    if ((ABANDONABLE_ROTATION_STATUSES as readonly string[]).includes(row.status)) {
      abandonable.push(row)
    } else if ((HELD_ROTATION_STATUSES as readonly string[]).includes(row.status)) {
      held.push(row)
    } else {
      throw new UnhandledBlockingRotationStatusError(row.status)
    }
  }
  return { abandonable, held }
}

/** Story 43-15 AC-8: an abandon in Phase 2 did not end `abandoned` — rolls the savepoint back. */
class RotationHandlingConflictError extends Error {
  constructor(rotationId: string, outcome: string) {
    super(`abandonRotation(${rotationId}) returned '${outcome}' after its lock was pre-acquired`)
    this.name = 'RotationHandlingConflictError'
  }
}

export type RotationGuardOutcome =
  /** Default request and the target owns blocking rotations: the FR102 409. */
  | { outcome: 'blocked'; rotationIds: string[] }
  /** `abandon` requested, but one of the rotations is being modified right now: nothing changed. */
  | { outcome: 'busy' }
  /** Safe to deactivate/remove: nothing blocking, or every abandonable rotation now abandoned. */
  | { outcome: 'clear'; abandonedRotationIds: string[]; heldRotationIds: string[] }

/**
 * Story 43-15 AC-2/AC-8/AC-9: the rotation guard shared by POST /org/users/:userId/deactivate and
 * DELETE /org/users/:userId. The caller runs it after locking the target's membership row FOR
 * UPDATE and after its own self/hierarchy/idempotency/structural checks, and before any mutation.
 *
 * Without `rotationHandling` it only reads, returning `blocked` when the target owns blocking
 * rotations. With `abandon` (FR102 explicit orphan handling: "cancel" + "hold pending review") it
 * runs in two phases, because secureRoute commits on return:
 *  1. No writes: partition into ABANDONABLE/HELD and try-lock every abandonable rotation's
 *     rotation-scoped advisory lock (transaction-scoped, re-entrant). Any busy lock → `busy`.
 *  2. Inside a savepoint: `abandonRotation` (never a raw CAS — it also marks the new version
 *     abandoned and unlocks the previous one) plus one ROTATION_ABANDONED audit row each. A
 *     non-`abandoned` outcome throws, rolling the savepoint back, and is reported as `busy`; an
 *     audit fail-closed error propagates and rolls back the whole request.
 * Held rotations are left as they are; any org admin can retire/resume them later.
 *
 * Locking: rotation-scoped try-locks never wait, and initiateRotation takes the credential-scoped
 * lock then the membership row, so this path (membership row → rotation try-locks) cannot
 * deadlock with it. A rotation the target starts concurrently waits on the membership row lock
 * the caller holds, then sees the deactivation/removal and is refused (AC-4).
 */
export async function enforceRotationHandling(
  tx: Tx,
  input: {
    auth: SecureRouteContext['auth']
    targetUserId: string
    handling: RotationHandlingBody['rotationHandling']
    request: FastifyRequest
    /** Merged into each ROTATION_ABANDONED payload: the reason plus the initiator's id. */
    abandonAuditPayload: Record<string, unknown>
  }
): Promise<RotationGuardOutcome> {
  const orgId = input.auth.orgId
  const rows = await findBlockingRotationsForUser(tx, input.targetUserId, orgId)
  if (rows.length === 0) return { outcome: 'clear', abandonedRotationIds: [], heldRotationIds: [] }
  if (input.handling !== 'abandon') {
    return { outcome: 'blocked', rotationIds: rows.map((row) => row.id) }
  }

  const { abandonable, held } = partitionBlockingRotations(rows)
  for (const rotation of abandonable) {
    if (!(await tryAcquireRotationScopedLock(tx, orgId, rotation.id))) return { outcome: 'busy' }
  }

  try {
    await tx.transaction(async (savepoint) => {
      for (const rotation of abandonable) {
        await abandonAndAudit(savepoint, rotation, input)
      }
    })
  } catch (error) {
    if (error instanceof RotationHandlingConflictError) return { outcome: 'busy' }
    throw error
  }
  return {
    outcome: 'clear',
    abandonedRotationIds: abandonable.map((row) => row.id),
    heldRotationIds: held.map((row) => row.id),
  }
}

async function abandonAndAudit(
  tx: Tx,
  rotation: BlockingRotation,
  input: Parameters<typeof enforceRotationHandling>[1]
): Promise<void> {
  const params = {
    orgId: input.auth.orgId,
    projectId: rotation.projectId,
    credentialId: rotation.credentialId,
    rotationId: rotation.id,
  }
  const result = await abandonRotation(tx, params)
  if (result.outcome !== 'abandoned') {
    throw new RotationHandlingConflictError(rotation.id, result.outcome)
  }
  await writeRotationAbandonedAuditOrThrow(
    tx,
    input.auth,
    input.request,
    params,
    result.rotation,
    input.abandonAuditPayload
  )
}

/**
 * AC-7: revokes every pending project invitation the deactivated user *sent* (invitedBy) within
 * this org — invitations addressed *to* them are untouched (D3/AC-7 edge case). Already-accepted,
 * already-revoked, or already-expired invitations are left alone (nothing to do).
 */
export async function revokePendingInvitationsSentBy(
  tx: Tx,
  input: { orgId: string; userId: string }
): Promise<number> {
  const revoked = await tx
    .update(projectInvitations)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(projectInvitations.orgId, input.orgId),
        eq(projectInvitations.invitedBy, input.userId),
        isNull(projectInvitations.acceptedAt),
        isNull(projectInvitations.revokedAt),
        gt(projectInvitations.expiresAt, new Date())
      )
    )
    .returning({ id: projectInvitations.id })
  return revoked.length
}
