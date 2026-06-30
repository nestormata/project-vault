import { and, count, eq, isNull } from 'drizzle-orm'
import type { EventEmitter } from 'node:events'
import { withOrg, withOrgAndUser } from '@project-vault/db'
import { notificationInbox, notificationQueue } from '@project-vault/db/schema'
import { emitSseEvent } from '../lib/events.js'
import { renderTemplate } from '../notifications/templates/index.js'
import { env } from '../config/env.js'
import { claimPendingNotificationEntry } from './notification-queue-ops.js'

let _emitterOverride: EventEmitter | null | undefined

export function setEmitterForTesting(emitter: EventEmitter | null): void {
  _emitterOverride = emitter
}

export function resetEmitterForTesting(): void {
  _emitterOverride = undefined
}

export async function deliverInboxNotification(
  notificationQueueId: string,
  orgId: string,
  emitter: EventEmitter
): Promise<void> {
  const activeEmitter = _emitterOverride === undefined ? emitter : _emitterOverride
  if (!activeEmitter) return

  const entry = await claimPendingNotificationEntry(notificationQueueId, orgId)
  if (!entry || entry.channel !== 'inbox') return
  if (!entry.recipientUserId) return
  const recipientUserId = entry.recipientUserId

  const rendered = renderTemplate(entry.templateId, entry.payload as Record<string, unknown>)
  const payload = entry.payload as Record<string, unknown>
  const expiresAt = new Date(Date.now() + env.INBOX_RETENTION_DAYS * 24 * 60 * 60 * 1000)

  const unreadCount = await withOrgAndUser(orgId, recipientUserId, async (tx) => {
    await tx.insert(notificationInbox).values({
      orgId,
      userId: recipientUserId,
      alertType: entry.templateId,
      severity: (payload.severity as string | undefined) ?? 'warning',
      payload: {
        title: rendered.inboxTitle,
        body: rendered.inboxBody,
        projectId: payload.projectId,
        resourceId: payload.resourceId,
        resourceType: payload.resourceType,
      },
      expiresAt,
    })

    await tx
      .update(notificationQueue)
      .set({ status: 'delivered', deliveredAt: new Date() })
      .where(eq(notificationQueue.id, entry.id))

    const [countRow] = await tx
      .select({ count: count() })
      .from(notificationInbox)
      .where(
        and(
          eq(notificationInbox.orgId, orgId),
          eq(notificationInbox.userId, recipientUserId),
          isNull(notificationInbox.readAt),
          isNull(notificationInbox.dismissedAt)
        )
      )

    return countRow?.count ?? 0
  })

  emitSseEvent(activeEmitter, 'notification.inbox', '', orgId, { unreadCount })
}

export async function countUnreadInboxEntries(orgId: string, userId: string): Promise<number> {
  const [row] = await withOrgAndUser(orgId, userId, (tx) =>
    tx
      .select({ count: count() })
      .from(notificationInbox)
      .where(
        and(
          eq(notificationInbox.orgId, orgId),
          eq(notificationInbox.userId, userId),
          isNull(notificationInbox.readAt),
          isNull(notificationInbox.dismissedAt)
        )
      )
  )
  return row?.count ?? 0
}

export async function seedInboxEntryForTest(
  orgId: string,
  userId: string,
  overrides: Partial<typeof notificationInbox.$inferInsert> = {}
): Promise<string> {
  const expiresAt =
    overrides.expiresAt ?? new Date(Date.now() + env.INBOX_RETENTION_DAYS * 24 * 60 * 60 * 1000)
  const [row] = await withOrgAndUser(orgId, userId, (tx) =>
    tx
      .insert(notificationInbox)
      .values({
        orgId,
        userId,
        alertType: 'security.failed_auth_threshold',
        severity: 'warning',
        payload: { title: 'Test', body: 'Test body' },
        expiresAt,
        ...overrides,
      })
      .returning({ id: notificationInbox.id })
  )
  if (!row?.id) throw new Error('expected inbox entry')
  return row.id
}

export async function countInboxEntriesForTest(orgId: string, userId: string): Promise<number> {
  const rows = await withOrgAndUser(orgId, userId, (tx) =>
    tx.select({ id: notificationInbox.id }).from(notificationInbox)
  )
  return rows.length
}

/** Cross-org purge helper for tests — uses withOrg only to verify rows after purge. */
export async function listInboxEntryIds(orgId: string, userId: string): Promise<string[]> {
  const rows = await withOrgAndUser(orgId, userId, (tx) =>
    tx.select({ id: notificationInbox.id }).from(notificationInbox)
  )
  return rows.map((row) => row.id)
}

export async function listInboxEntriesForTest(orgId: string, userId: string) {
  return withOrgAndUser(orgId, userId, (tx) =>
    tx.select().from(notificationInbox).where(eq(notificationInbox.userId, userId))
  )
}

export async function insertInboxQueueEntry(
  orgId: string,
  userId: string,
  values: Partial<typeof notificationQueue.$inferInsert> = {}
): Promise<string> {
  const [row] = await withOrg(orgId, (tx) =>
    tx
      .insert(notificationQueue)
      .values({
        orgId,
        recipientUserId: userId,
        channel: 'inbox',
        templateId: 'security.failed_auth_threshold',
        payload: { severity: 'warning' },
        status: 'pending',
        ...values,
      })
      .returning({ id: notificationQueue.id })
  )
  if (!row?.id) throw new Error('expected queue entry')
  return row.id
}
