import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { eq, and } from 'drizzle-orm'
import { withOrg, withOrgAndUser } from '@project-vault/db'
import { notificationInbox, notificationQueue } from '@project-vault/db/schema'
import { createTestUser, deleteTestUser, withTestOrg } from '@project-vault/db/test-helpers'
import {
  deliverInboxNotification,
  insertInboxQueueEntry,
  resetEmitterForTesting,
  setEmitterForTesting,
} from './notification-inbox.js'
import type { SseEnvelope } from '../lib/events.js'

const FAILED_AUTH_ALERT = 'security.failed_auth_threshold'

const SAMPLE_QUEUE_PAYLOAD = {
  thresholdType: 'ip' as const,
  thresholdCount: 10,
  windowSeconds: 300,
  attemptCount: 10,
  windowStart: '2026-06-30T00:00:00.000Z',
  windowEnd: '2026-06-30T00:05:00.000Z',
  ipAddress: '203.0.113.1',
  severity: 'warning',
}

function createMockEventEmitter() {
  const emitter = new EventEmitter()
  const emittedEvents: SseEnvelope[] = []
  emitter.on('sse', (event: SseEnvelope) => emittedEvents.push(event))
  return { emitter, emittedEvents }
}

describe('inbox delivery worker', () => {
  it('creates notification_inbox entry when channel="inbox" queue entry is delivered', async () => {
    const userId = await createTestUser('inbox-deliver')
    try {
      await withTestOrg(async ({ orgId }) => {
        const queueId = await insertInboxQueueEntry(orgId, userId, {
          payload: SAMPLE_QUEUE_PAYLOAD,
        })
        const { emitter, emittedEvents } = createMockEventEmitter()
        setEmitterForTesting(emitter)

        await deliverInboxNotification(queueId, orgId, emitter)

        const inboxEntries = await withOrgAndUser(orgId, userId, (tx) =>
          tx.select().from(notificationInbox).where(eq(notificationInbox.userId, userId))
        )
        expect(inboxEntries).toHaveLength(1)
        expect(inboxEntries[0]?.alertType).toBe(FAILED_AUTH_ALERT)
        expect(inboxEntries[0]?.readAt).toBeNull()

        const [updated] = await withOrg(orgId, (tx) =>
          tx.select().from(notificationQueue).where(eq(notificationQueue.id, queueId))
        )
        expect(updated?.status).toBe('delivered')

        expect(emittedEvents).toContainEqual(
          expect.objectContaining({
            event: 'notification.inbox',
            data: expect.objectContaining({ unreadCount: 1 }),
          })
        )
      })
    } finally {
      resetEmitterForTesting()
      await deleteTestUser(userId)
    }
  })

  it('is idempotent: skips if queue entry already delivered', async () => {
    const userId = await createTestUser('inbox-idempotent')
    try {
      await withTestOrg(async ({ orgId }) => {
        const queueId = await insertInboxQueueEntry(orgId, userId, { status: 'delivered' })
        const { emitter, emittedEvents } = createMockEventEmitter()

        await deliverInboxNotification(queueId, orgId, emitter)

        const inboxEntries = await withOrgAndUser(orgId, userId, (tx) =>
          tx.select().from(notificationInbox).where(eq(notificationInbox.userId, userId))
        )
        expect(inboxEntries).toHaveLength(0)
        expect(emittedEvents).toHaveLength(0)
      })
    } finally {
      await deleteTestUser(userId)
    }
  })

  it('inbox entries are isolated per org (dual RLS)', async () => {
    const userId = await createTestUser('inbox-org-rls')
    try {
      await withTestOrg(async ({ orgId: orgAId }) => {
        await withTestOrg(async ({ orgId: orgBId }) => {
          await withOrgAndUser(orgAId, userId, (tx) =>
            tx.insert(notificationInbox).values({
              orgId: orgAId,
              userId,
              alertType: FAILED_AUTH_ALERT,
              severity: 'warning',
              payload: { title: 'Test', body: 'Test body' },
              expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
            })
          )

          const inOrgB = await withOrgAndUser(orgBId, userId, (tx) =>
            tx.select().from(notificationInbox).where(eq(notificationInbox.orgId, orgAId))
          )
          expect(inOrgB).toHaveLength(0)
        })
      })
    } finally {
      await deleteTestUser(userId)
    }
  })

  it('withOrg() after withOrgAndUser() does not leak user_id', async () => {
    const userId = await createTestUser('inbox-user-leak')
    try {
      await withTestOrg(async ({ orgId }) => {
        await withOrgAndUser(orgId, userId, (tx) =>
          tx.insert(notificationInbox).values({
            orgId,
            userId,
            alertType: 'security.failed_auth_threshold',
            severity: 'warning',
            payload: { title: 'Test', body: 'Test body' },
            expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
          })
        )

        const leakedEntries = await withOrg(orgId, (tx) =>
          tx
            .select()
            .from(notificationInbox)
            .where(and(eq(notificationInbox.orgId, orgId)))
        )
        expect(leakedEntries).toHaveLength(0)
      })
    } finally {
      await deleteTestUser(userId)
    }
  })
})
