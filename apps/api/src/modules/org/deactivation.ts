import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm'
import type { FastifyRequest } from 'fastify'
import type { Tx } from '@project-vault/db'
import { orgMemberships, projectInvitations, rotations } from '@project-vault/db/schema'
import type { RotationHandlingBody } from '@project-vault/shared'
import { mapWithConcurrency } from '../../lib/map-with-concurrency.js'
import { tryAcquireRotationScopedLock } from '../../lib/rotation-locks.js'
import { roleRank, type SecureRouteContext } from '../../lib/secure-route.js'
import type { OrgRole } from '../../plugins/require-org-role.js'
import { dispatchDirectUserNotification } from '../../notifications/dispatcher.js'
import type { NotificationQueueJob } from '../../notifications/dispatcher.js'
import { BLOCKING_ROTATION_STATUSES } from '../projects/archive-guards.js'
import { abandonRotation } from '../rotation/service.js'
import {
  writeRotationAbandonedAuditOrThrow,
  writeRotationOwnershipTransferredAuditOrThrow,
} from '../rotation/rotation-audit.js'

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

// Story 43-17 (Failure Mode Analysis): `rotationHandling: "transfer"` moves ownership of ALL four
// blocking statuses (a staged rotation can finish under the new owner; promoted/legacy in_progress
// get a named owner instead of being merely held). A drift-guard test asserts this list equals
// BLOCKING_ROTATION_STATUSES exactly, so a future blocking status fails the guard instead of being
// silently skipped. retired/completed/abandoned rotations are never touched.
export const TRANSFERRABLE_ROTATION_STATUSES = [
  'staged',
  'promoted',
  'stale_recovery',
  'in_progress',
] as const

/** A blocking status in neither list above (e.g. a future `paused`) — never silently mishandled. */
export class UnhandledBlockingRotationStatusError extends Error {
  constructor(status: string) {
    super(`No rotationHandling rule for blocking rotation status '${status}'`)
    this.name = 'UnhandledBlockingRotationStatusError'
  }
}

/**
 * Story 43-15 AC-1/AC-3, widened by 43-17 AC-2: the target's blocking rotations in this org —
 * the EFFECTIVE owner `COALESCE(owner_user_id, initiated_by) = userId` (a transferred rotation
 * belongs to its new owner; a NULL owner and NULL initiator never match), status in
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
        sql`COALESCE(${rotations.ownerUserId}, ${rotations.initiatedBy}) = ${userId}`,
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

/** Story 43-17: every blocking status is transferrable; an unknown one is never silently skipped. */
export function assertTransferableRotations(rows: BlockingRotation[]): BlockingRotation[] {
  for (const row of rows) {
    if (!(TRANSFERRABLE_ROTATION_STATUSES as readonly string[]).includes(row.status)) {
      throw new UnhandledBlockingRotationStatusError(row.status)
    }
  }
  return rows
}

/**
 * Story 43-17 KD-5/AC-5: whether `transferToUserId` may receive the deactivated/removed user's
 * rotations: an ACTIVE membership of this org with a role that may act on rotations (the same
 * `minimumRole: 'admin'` gate every rotation route uses, via `roleRank`), never the user being
 * deactivated/removed. A cross-org or unknown id simply has no membership row here, so the caller
 * cannot tell it from a merely ineligible user (one generic 422). The row is read FOR SHARE so the
 * new owner cannot be deactivated between this check and commit: LOCK ORDER is
 * membership(deactivated user, FOR UPDATE by the route) -> membership(transfer target, FOR SHARE,
 * here) -> rotation-scoped try-locks (enforceRotationHandling). A concurrent deactivation of the
 * target takes FOR UPDATE on its own row, so it waits for this transaction and then finds the
 * transferred rotations blocking it (409 active_rotations); if it committed first, this read sees
 * `deactivated` and the transfer is refused.
 */
export async function validateTransferTarget(
  tx: Tx,
  orgId: string,
  input: { transferToUserId: string; deactivatedUserId: string }
): Promise<boolean> {
  if (input.transferToUserId === input.deactivatedUserId) return false
  const [membership] = await tx
    .select({ role: orgMemberships.role, status: orgMemberships.status })
    .from(orgMemberships)
    .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, input.transferToUserId)))
    .for('share')
    .limit(1)
  return (
    membership?.status === 'active' && roleRank(membership.role as OrgRole) >= roleRank('admin')
  )
}

/**
 * Story 43-17 review (deadlock): takes the two membership row locks a transfer needs in ONE global
 * order (ascending user id) instead of "deactivated user, then transfer target". Two concurrent
 * requests that each deactivate one admin while naming the other as target would otherwise each
 * hold their own target FOR UPDATE and wait for the other's row FOR SHARE (a deadlock Postgres
 * resolves by aborting one with a 500). The deactivated user's row is locked FOR UPDATE and the
 * transfer target's FOR SHARE, exactly as before; the route's later lock/validate calls on the same
 * rows are re-entrant. Call this BEFORE `lockOrgMembershipForUpdate` on the deactivated user.
 */
export async function lockTransferMembershipsInOrder(
  tx: Tx,
  orgId: string,
  input: { deactivatedUserId: string; transferToUserId: string }
): Promise<void> {
  if (input.deactivatedUserId === input.transferToUserId) return
  const lockRow = async (userId: string): Promise<void> => {
    const query = tx
      .select({ status: orgMemberships.status })
      .from(orgMemberships)
      .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)))
    await query.for(userId === input.deactivatedUserId ? 'update' : 'share').limit(1)
  }
  const [first, second] = [input.deactivatedUserId, input.transferToUserId].sort()
  if (first === undefined || second === undefined) return
  await lockRow(first)
  await lockRow(second)
}

/** Story 43-15 AC-8: an abandon in Phase 2 did not end `abandoned` — rolls the savepoint back. */
class RotationHandlingConflictError extends Error {
  constructor(rotationId: string, outcome: string) {
    super(`abandonRotation(${rotationId}) returned '${outcome}' after its lock was pre-acquired`)
    this.name = 'RotationHandlingConflictError'
  }
}

/** Story 43-17: what `rotationHandling: "transfer"` moved, and the new-owner notice to send. */
export type RotationTransferResult = {
  rotationIds: string[]
  toUserId: string
  notificationJobs: NotificationQueueJob[]
}

export type RotationGuardOutcome =
  /** Default request and the target owns blocking rotations: the FR102 409. */
  | { outcome: 'blocked'; rotationIds: string[] }
  /** `abandon`/`transfer` requested, but one of the rotations is being modified right now: nothing changed. */
  | { outcome: 'busy' }
  /** Safe to deactivate/remove: nothing blocking, or every blocking rotation now handled. */
  | {
      outcome: 'clear'
      abandonedRotationIds: string[]
      heldRotationIds: string[]
      /** Present only for `transfer` (even when there was nothing to move). */
      transfer?: RotationTransferResult
    }

type RotationHandlingInput = {
  auth: SecureRouteContext['auth']
  targetUserId: string
  handling: RotationHandlingBody['rotationHandling']
  request: FastifyRequest
  /** Merged into each ROTATION_ABANDONED payload: the reason plus the initiator's id. */
  abandonAuditPayload: Record<string, unknown>
  /** Story 43-17: required when `handling === 'transfer'` (already validated by the caller). */
  transfer?: { toUserId: string; reason: 'owner_deactivated' | 'owner_removed' }
}

/**
 * Story 43-15 AC-2/AC-8/AC-9, extended by 43-17: the rotation guard shared by
 * POST /org/users/:userId/deactivate and DELETE /org/users/:userId. The caller runs it after
 * locking the target's membership row FOR UPDATE and after its own self/hierarchy/idempotency/
 * structural checks (and, for `transfer`, after `validateTransferTarget`), and before any mutation.
 *
 * Without `rotationHandling` it only reads, returning `blocked` when the target owns blocking
 * rotations. With `abandon` (FR102 explicit orphan handling: "cancel" + "hold pending review") or
 * `transfer` (FR102 "transfer to another admin") it runs in two phases, because secureRoute
 * commits on return:
 *  1. No writes: partition (abandon) or status-check (transfer), then try-lock every affected
 *     rotation's rotation-scoped advisory lock (transaction-scoped, re-entrant). Any busy → `busy`.
 *  2. Inside a savepoint: `abandonRotation` plus a ROTATION_ABANDONED audit row each, or the
 *     ownership UPDATE plus a ROTATION_OWNERSHIP_TRANSFERRED audit row each. A conflict throws,
 *     rolling the savepoint back, and is reported as `busy`; an audit fail-closed error propagates
 *     and rolls back the whole request.
 * Held rotations are left as they are; any org admin can retire/resume them later.
 *
 * Locking: rotation-scoped try-locks never wait, and initiateRotation takes the credential-scoped
 * lock then the membership row, so this path (membership row -> rotation try-locks) cannot
 * deadlock with it. A rotation the target starts concurrently waits on the membership row lock
 * the caller holds, then sees the deactivation/removal and is refused (AC-4).
 */
export async function enforceRotationHandling(
  tx: Tx,
  input: RotationHandlingInput
): Promise<RotationGuardOutcome> {
  const orgId = input.auth.orgId
  const rows = await findBlockingRotationsForUser(tx, input.targetUserId, orgId)
  if (input.handling === 'transfer') return transferRotations(tx, rows, input)
  if (rows.length === 0) return { outcome: 'clear', abandonedRotationIds: [], heldRotationIds: [] }
  if (input.handling !== 'abandon') {
    return { outcome: 'blocked', rotationIds: rows.map((row) => row.id) }
  }

  const { abandonable, held } = partitionBlockingRotations(rows)
  if (!(await tryLockAll(tx, orgId, abandonable))) return { outcome: 'busy' }

  const completed = await runInSavepoint(tx, async (savepoint) => {
    // Strictly sequential (limit 1): abandonRotation and its audit row are order-sensitive.
    await mapWithConcurrency(abandonable, 1, (rotation) =>
      abandonAndAudit(savepoint, rotation, input)
    )
  })
  if (!completed) return { outcome: 'busy' }
  return {
    outcome: 'clear',
    abandonedRotationIds: abandonable.map((row) => row.id),
    heldRotationIds: held.map((row) => row.id),
  }
}

/** Phase 1 (shared by abandon and transfer): try-lock every rotation, stopping at the first busy. */
async function tryLockAll(
  tx: Tx,
  orgId: string,
  rotationsToLock: readonly { id: string }[]
): Promise<boolean> {
  const [first, ...rest] = rotationsToLock
  if (!first) return true
  if (!(await tryAcquireRotationScopedLock(tx, orgId, first.id))) return false
  return tryLockAll(tx, orgId, rest)
}

/** Phase 2 (shared): runs `work` in a savepoint; a handling conflict rolls it back → `false` (busy). */
async function runInSavepoint(tx: Tx, work: (savepoint: Tx) => Promise<void>): Promise<boolean> {
  try {
    await tx.transaction(work)
  } catch (error) {
    if (error instanceof RotationHandlingConflictError) return false
    throw error
  }
  return true
}

async function transferRotations(
  tx: Tx,
  rows: BlockingRotation[],
  input: RotationHandlingInput
): Promise<RotationGuardOutcome> {
  const transfer = input.transfer
  if (!transfer) throw new Error('rotationHandling "transfer" requires a validated transfer target')
  const none = { outcome: 'clear' as const, abandonedRotationIds: [], heldRotationIds: [] }
  if (rows.length === 0) {
    return {
      ...none,
      transfer: { rotationIds: [], toUserId: transfer.toUserId, notificationJobs: [] },
    }
  }

  const transferable = assertTransferableRotations(rows)
  if (!(await tryLockAll(tx, input.auth.orgId, transferable))) return { outcome: 'busy' }

  const completed = await runInSavepoint(tx, (savepoint) =>
    transferAndAudit(savepoint, transferable, input, transfer)
  )
  if (!completed) return { outcome: 'busy' }
  return {
    ...none,
    transfer: {
      rotationIds: transferable.map((row) => row.id),
      toUserId: transfer.toUserId,
      notificationJobs: await notifyNewOwner(tx, input, transfer, transferable),
    },
  }
}

/**
 * Story 43-17 KD-4/KD-6: one UPDATE moves every rotation (re-checking status and the effective
 * owner under the rotation locks — a miss means something changed it, so the savepoint rolls back
 * as `busy`), then one fail-closed ROTATION_OWNERSHIP_TRANSFERRED audit row per rotation, written
 * strictly in order (limit 1) because the audit chain is order-sensitive. `initiated_by` is never
 * written (KD-1); the status is unchanged, so RETURNING status is the previous status.
 */
async function transferAndAudit(
  tx: Tx,
  transferable: BlockingRotation[],
  input: RotationHandlingInput,
  transfer: NonNullable<RotationHandlingInput['transfer']>
): Promise<void> {
  const moved = await tx
    .update(rotations)
    .set({ ownerUserId: transfer.toUserId, updatedAt: new Date() })
    .where(
      and(
        eq(rotations.orgId, input.auth.orgId),
        inArray(
          rotations.id,
          transferable.map((row) => row.id)
        ),
        inArray(rotations.status, BLOCKING_ROTATION_STATUSES),
        sql`COALESCE(${rotations.ownerUserId}, ${rotations.initiatedBy}) = ${input.targetUserId}`
      )
    )
    .returning({ id: rotations.id, status: rotations.status })
  if (moved.length !== transferable.length) {
    throw new RotationHandlingConflictError(transferable.map((row) => row.id).join(','), 'moved')
  }
  const previousStatus = new Map(moved.map((row) => [row.id, row.status]))
  await mapWithConcurrency(transferable, 1, (rotation) =>
    writeRotationOwnershipTransferredAuditOrThrow(
      tx,
      input.auth,
      input.request,
      { orgId: input.auth.orgId, credentialId: rotation.credentialId, rotationId: rotation.id },
      {
        credentialId: rotation.credentialId,
        fromUserId: input.targetUserId,
        toUserId: transfer.toUserId,
        reason: transfer.reason,
        previousStatus: previousStatus.get(rotation.id) ?? rotation.status,
      }
    )
  )
}

/**
 * Story 43-17 KD-7: one direct-to-new-owner notice with the count (no secret values). Best-effort
 * in a nested savepoint: a dispatch failure never blocks or rolls back the hand-over (the audit
 * rows are the durable record). The previous owner is being deactivated/removed: not notified.
 */
async function notifyNewOwner(
  tx: Tx,
  input: RotationHandlingInput,
  transfer: NonNullable<RotationHandlingInput['transfer']>,
  transferred: BlockingRotation[]
): Promise<NotificationQueueJob[]> {
  try {
    return await tx.transaction((savepoint) =>
      dispatchDirectUserNotification({
        orgId: input.auth.orgId,
        userId: transfer.toUserId,
        template: {
          templateId: 'rotation.ownership_transferred',
          payload: {
            rotationCount: transferred.length,
            rotationIds: transferred.map((row) => row.id),
            fromUserId: input.targetUserId,
            reason: transfer.reason,
          },
          severity: 'warning',
        },
        tx: savepoint,
      })
    )
  } catch (error) {
    input.request.log.warn(
      { err: error, toUserId: transfer.toUserId, rotationCount: transferred.length },
      'Rotation ownership transfer notice could not be queued — hand-over unaffected'
    )
    return []
  }
}

async function abandonAndAudit(
  tx: Tx,
  rotation: BlockingRotation,
  input: RotationHandlingInput
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
