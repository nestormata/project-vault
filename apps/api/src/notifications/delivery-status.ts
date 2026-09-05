import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { notificationQueue } from '@project-vault/db/schema'
import { AuditEvent } from '@project-vault/shared'
import type { FastifyBaseLogger } from 'fastify'
import { writeSystemAuditEntryOrFailClosed } from '../lib/audit-or-fail-closed.js'
import { operationalLog } from '../lib/logger.js'

/**
 * Story 20.11 AC2 — `notification_queue.status`'s ordered, asynchronous-capable state model.
 * `pending` is PV's own pre-send state; every other value may be reported by either the built-in
 * SMTP path (`delivered`/`failed`/`suppressed`, unchanged from Story 3.1) or a registered
 * `DeliveryProvider`'s webhook callback (`sent`/`delivered`/`bounced`/`suppressed`/`failed`).
 */
export type NotificationQueueStatus =
  'pending' | 'sent' | 'delivered' | 'bounced' | 'suppressed' | 'failed'

/**
 * Story 20.11 AC2 — the explicit rank table `applyDeliveryStatusUpdate()` uses as the single
 * source of ordering truth (AC4) for every call site (the webhook route, the SMTP send path, and
 * any future provider-polling fallback). `bounced`/`suppressed`/`failed` share rank 3: all three
 * are equally terminal, and Postgres delivery order across a real provider gives no meaningful
 * ordering between them.
 */
export const DELIVERY_STATUS_RANK: Record<NotificationQueueStatus, number> = {
  pending: 0,
  sent: 1,
  delivered: 2,
  bounced: 3,
  suppressed: 3,
  failed: 3,
}

export type ApplyDeliveryStatusUpdateInput = {
  notificationQueueId: string
  orgId: string
  newStatus: NotificationQueueStatus
  /** The provider that reported this event, recorded on the audit payload only — never used to
   * resolve RLS context (the caller has already resolved `orgId` from the row itself, AC3). */
  providerId?: string | null
  /** Story 20.11 AC1/AC9 — set only by the initial send-time `pending -> sent` transition (the
   * dispatcher's own call site), to persist the provider's returned message identifier on the row
   * for later webhook resolution. Never present on a webhook-sourced call — the webhook already
   * resolved the row BY this identifier, so there is nothing new to write. */
  providerMessageId?: string
}

export type ApplyDeliveryStatusUpdateResult =
  | { outcome: 'applied' }
  | { outcome: 'idempotent_noop' }
  | { outcome: 'discarded_backward'; currentStatus: NotificationQueueStatus }
  | { outcome: 'not_found' }

type Logger = Partial<Pick<FastifyBaseLogger, 'warn'>>

/**
 * Story 20.11 AC2/AC4 — the single, generalized forward-progress guard every call site that
 * mutates `notification_queue.status` after the initial send must go through. Writes a status
 * update only when `newRank >= currentRank` (forward progress, including a same-rank move between
 * two different terminal statuses) — anything else (a strictly lower rank) is discarded: logged,
 * never thrown, never applied. An identical-status replay is a no-op that still refreshes
 * `lastEventAt` but never re-writes `status` or re-audits (AC2 edge case: must not double-count a
 * delivery metric on duplicate webhook redelivery).
 */
export async function applyDeliveryStatusUpdate(
  input: ApplyDeliveryStatusUpdateInput,
  logger: Logger = {}
): Promise<ApplyDeliveryStatusUpdateResult> {
  return withOrg(input.orgId, async (tx) => {
    const [row] = await tx
      .select()
      .from(notificationQueue)
      .where(eq(notificationQueue.id, input.notificationQueueId))
      .limit(1)
    if (!row) return { outcome: 'not_found' }

    const currentStatus = row.status as NotificationQueueStatus
    // currentStatus is read from notification_queue.status, which is itself constrained by that
    // column's own CHECK constraint to exactly the NotificationQueueStatus values
    // DELIVERY_STATUS_RANK enumerates (migration 0089) — not attacker-controlled arbitrary-string
    // lookup.
    // eslint-disable-next-line security/detect-object-injection
    const currentRank = DELIVERY_STATUS_RANK[currentStatus]
    const newRank = DELIVERY_STATUS_RANK[input.newStatus]

    if (newRank < currentRank) {
      operationalLog(
        logger,
        'warn',
        'notification.delivery_status_discarded',
        'Delivery-status update discarded: would move the queue row backward',
        {
          notificationQueueId: row.id,
          currentStatus,
          rejectedStatus: input.newStatus,
        }
      )
      return { outcome: 'discarded_backward', currentStatus }
    }

    const now = new Date()

    if (currentStatus === input.newStatus) {
      await tx
        .update(notificationQueue)
        .set({ lastEventAt: now })
        .where(eq(notificationQueue.id, row.id))
      return { outcome: 'idempotent_noop' }
    }

    await tx
      .update(notificationQueue)
      .set({
        status: input.newStatus,
        lastEventAt: now,
        ...(input.newStatus === 'delivered' ? { deliveredAt: now } : {}),
        ...(input.providerId !== undefined ? { providerId: input.providerId } : {}),
        ...(input.providerMessageId !== undefined
          ? { providerMessageId: input.providerMessageId }
          : {}),
      })
      .where(eq(notificationQueue.id, row.id))

    await writeSystemAuditEntryOrFailClosed(tx, {
      orgId: input.orgId,
      eventType: AuditEvent.NOTIFICATION_DELIVERY_STATUS_UPDATED,
      resourceId: row.id,
      resourceType: 'notification_queue',
      payload: {
        providerId: input.providerId ?? row.providerId ?? null,
        oldStatus: currentStatus,
        newStatus: input.newStatus,
        updatedAt: now.toISOString(),
      },
    })

    return { outcome: 'applied' }
  })
}
