import { and, eq, isNull, lt, lte, or, sql } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { notificationQueue } from '@project-vault/db/schema'
import { applyDeliveryStatusUpdate } from '../notifications/delivery-status.js'
import {
  NOTIFICATION_CLAIM_LEASE_SECONDS,
  NOTIFICATION_MAX_ATTEMPTS,
} from './notification-worker-common.js'

export type NotificationQueueRow = typeof notificationQueue.$inferSelect

/**
 * Story 70.1 AC1 — the exclusive claim: ONE conditional UPDATE ... RETURNING (no preceding
 * SELECT). Under READ COMMITTED a concurrent second UPDATE blocks on the row lock, re-evaluates
 * the WHERE against the committed version (lease now in the future) and matches zero rows, so
 * exactly one caller wins. Returns the POST-update row (`attemptCount` is the number of this
 * attempt, starting at 1) or `null` when the row is not claimable: not `pending`, attempt budget
 * exhausted, `deliver_at` in the future (DB clock), a live lease, or a send already started
 * (Decisions 2026-09-30 — such a row is never re-sent; see markNotificationSendStarted).
 * A losing caller writes nothing.
 */
export async function claimPendingNotificationEntry(
  notificationQueueId: string,
  orgId: string
): Promise<NotificationQueueRow | null> {
  return withOrg(orgId, async (tx) => {
    const [row] = await tx
      .update(notificationQueue)
      .set({
        attemptCount: sql`${notificationQueue.attemptCount} + 1`,
        lastAttemptAt: sql`now()`,
        claimExpiresAt: sql`now() + (${NOTIFICATION_CLAIM_LEASE_SECONDS} * interval '1 second')`,
      })
      .where(
        and(
          eq(notificationQueue.id, notificationQueueId),
          eq(notificationQueue.status, 'pending'),
          lt(notificationQueue.attemptCount, NOTIFICATION_MAX_ATTEMPTS),
          or(isNull(notificationQueue.deliverAt), lte(notificationQueue.deliverAt, sql`now()`)),
          or(
            isNull(notificationQueue.claimExpiresAt),
            lte(notificationQueue.claimExpiresAt, sql`now()`)
          ),
          isNull(notificationQueue.sendStartedAt)
        )
      )
      .returning()
    return row ?? null
  })
}

/**
 * Story 70.1 AC2 — releases this attempt's lease (and its send-in-progress marker, Decisions
 * 2026-09-30) so the pg-boss retry can reclaim immediately. Fenced on `attempt_count`: if this
 * attempt's lease already expired and another worker reclaimed (incrementing the count), the
 * release matches zero rows and never clears the newer attempt's lease. Must only be called when
 * the external send did NOT resolve — never after a resolved send (that row's outcome is
 * recorded, or unknown, and it must not be re-sent).
 */
export async function releaseNotificationClaim(
  notificationQueueId: string,
  orgId: string,
  claimedAttemptNumber: number
): Promise<void> {
  await withOrg(orgId, (tx) =>
    tx
      .update(notificationQueue)
      .set({ claimExpiresAt: null, sendStartedAt: null })
      .where(
        and(
          eq(notificationQueue.id, notificationQueueId),
          eq(notificationQueue.status, 'pending'),
          eq(notificationQueue.attemptCount, claimedAttemptNumber)
        )
      )
  )
}

/** Thrown by markNotificationSendStarted when this attempt no longer owns the row. */
export class NotificationClaimLostError extends Error {
  constructor(notificationQueueId: string) {
    super(`notification_queue ${notificationQueueId}: claim lost before send`)
    this.name = 'NotificationClaimLostError'
  }
}

/**
 * Story 70.1 Decisions 2026-09-30 (DW-252) — records, immediately before the external send, that
 * this attempt's send is in progress. Fenced on `attempt_count` like the release. From here on the
 * row is never claimed or re-enqueued again unless the send itself throws (the release then clears
 * the marker): a crash mid-send or a failed status commit after a resolved send leaves the marker
 * set, and the DLQ cleanup fails the row as outcome-unknown once the lease expires (at-most-once).
 * Throws NotificationClaimLostError when the attempt no longer owns the row (reclaimed after a
 * lease expiry, or no longer pending), so the send is never performed.
 */
export async function markNotificationSendStarted(
  notificationQueueId: string,
  orgId: string,
  claimedAttemptNumber: number
): Promise<void> {
  const marked = await withOrg(orgId, (tx) =>
    tx
      .update(notificationQueue)
      .set({ sendStartedAt: sql`now()` })
      .where(
        and(
          eq(notificationQueue.id, notificationQueueId),
          eq(notificationQueue.status, 'pending'),
          eq(notificationQueue.attemptCount, claimedAttemptNumber),
          isNull(notificationQueue.sendStartedAt)
        )
      )
      .returning({ id: notificationQueue.id })
  )
  if (marked.length !== 1) throw new NotificationClaimLostError(notificationQueueId)
}

// Story 20.11 AC4 (failure clause) — every status transition past the initial send, on ANY
// channel (SMTP or a registered DeliveryProvider), must go through applyDeliveryStatusUpdate()'s
// single rank-guarded, audited path — no call site may assign notification_queue.status directly.
// These three helpers keep their pre-existing signatures (every caller — notification-email.ts,
// notification-slack.ts, notification-dlq-cleanup.ts — is unchanged) but now delegate instead of
// writing the column themselves.

export async function markNotificationDelivered(
  notificationQueueId: string,
  orgId: string
): Promise<void> {
  await applyDeliveryStatusUpdate({ notificationQueueId, orgId, newStatus: 'delivered' })
}

export async function markNotificationSuppressed(
  notificationQueueId: string,
  orgId: string
): Promise<void> {
  await applyDeliveryStatusUpdate({ notificationQueueId, orgId, newStatus: 'suppressed' })
}

/** Returns true only when this call actually transitioned the row to `failed` — preserves the
 * pre-existing "did we just mark it failed" contract for notification-dlq-cleanup.ts's per-row
 * counter/log, so an already-failed (or otherwise already-terminal) row isn't double-counted. */
export async function markNotificationFailed(
  notificationQueueId: string,
  orgId: string
): Promise<boolean> {
  const result = await applyDeliveryStatusUpdate({
    notificationQueueId,
    orgId,
    newStatus: 'failed',
  })
  return result.outcome === 'applied'
}
