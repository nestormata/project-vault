import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { eq } from 'drizzle-orm'
import { createTestUser, deleteTestUser, withTestOrg } from '@project-vault/db/test-helpers'
import { withOrg } from '@project-vault/db'
import { notificationQueue } from '@project-vault/db/schema'
import { deliverNotification } from './notification-deliver.js'

async function insertPendingEntry(orgId: string, values: typeof notificationQueue.$inferInsert) {
  const [entry] = await withOrg(orgId, (tx) =>
    tx.insert(notificationQueue).values(values).returning({ id: notificationQueue.id })
  )
  if (!entry?.id) throw new Error('expected queue entry')
  return entry.id
}

async function fetchQueueStatus(orgId: string, entryId: string) {
  const [row] = await withOrg(orgId, (tx) =>
    tx.select().from(notificationQueue).where(eq(notificationQueue.id, entryId))
  )
  return row?.status
}

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

describe('notification deliver worker', () => {
  it('throws when inbox channel is delivered without emitter', async () => {
    await withTestOrg(async ({ orgId }) => {
      const entryId = await insertPendingEntry(orgId, {
        orgId,
        recipientUserId: null,
        channel: 'inbox',
        templateId: FAILED_AUTH_ALERT,
        payload: {},
        status: 'pending',
      })

      await expect(deliverNotification(entryId, orgId)).rejects.toThrow(/EventEmitter/)
      expect(await fetchQueueStatus(orgId, entryId)).toBe('pending')
    })
  })

  it('delivers inbox channel when emitter is provided', async () => {
    const userId = await createTestUser('deliver-inbox')
    try {
      await withTestOrg(async ({ orgId }) => {
        const entryId = await insertPendingEntry(orgId, {
          orgId,
          recipientUserId: userId,
          channel: 'inbox',
          templateId: FAILED_AUTH_ALERT,
          payload: SAMPLE_QUEUE_PAYLOAD,
          status: 'pending',
        })

        const emitter = new EventEmitter()
        await deliverNotification(entryId, orgId, emitter)
        expect(await fetchQueueStatus(orgId, entryId)).toBe('delivered')
      })
    } finally {
      await deleteTestUser(userId)
    }
  })

  it('skips entries with future deliverAt', async () => {
    await withTestOrg(async ({ orgId }) => {
      const entryId = await insertPendingEntry(orgId, {
        orgId,
        channel: 'email',
        templateId: FAILED_AUTH_ALERT,
        payload: {},
        status: 'pending',
        deliverAt: new Date(Date.now() + 3600_000),
      })

      await deliverNotification(entryId, orgId)
      expect(await fetchQueueStatus(orgId, entryId)).toBe('pending')
    })
  })
})
