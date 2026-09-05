import { eq, and } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { notificationQueue } from '@project-vault/db/schema'
import { applyDeliveryStatusUpdate } from '../notifications/delivery-status.js'

type NotificationQueueRow = typeof notificationQueue.$inferSelect

export async function claimPendingNotificationEntry(
  notificationQueueId: string,
  orgId: string
): Promise<NotificationQueueRow | null> {
  return withOrg(orgId, async (tx) => {
    const [row] = await tx
      .select()
      .from(notificationQueue)
      .where(eq(notificationQueue.id, notificationQueueId))
      .limit(1)
    if (row?.status !== 'pending') return null
    if (row.deliverAt && row.deliverAt.getTime() > Date.now()) return null

    await tx
      .update(notificationQueue)
      .set({
        attemptCount: row.attemptCount + 1,
        lastAttemptAt: new Date(),
      })
      .where(
        and(eq(notificationQueue.id, notificationQueueId), eq(notificationQueue.status, 'pending'))
      )
    return row
  })
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
