import { eq, and } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { notificationQueue } from '@project-vault/db/schema'

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
    if (!row || row.status !== 'pending') return null

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

export async function markNotificationDelivered(
  notificationQueueId: string,
  orgId: string
): Promise<void> {
  await withOrg(orgId, async (tx) => {
    await tx
      .update(notificationQueue)
      .set({ status: 'delivered', deliveredAt: new Date() })
      .where(eq(notificationQueue.id, notificationQueueId))
  })
}

export async function markNotificationSuppressed(
  notificationQueueId: string,
  orgId: string
): Promise<void> {
  await withOrg(orgId, async (tx) => {
    await tx
      .update(notificationQueue)
      .set({ status: 'suppressed' })
      .where(eq(notificationQueue.id, notificationQueueId))
  })
}
