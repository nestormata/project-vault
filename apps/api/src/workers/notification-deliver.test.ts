import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { notificationQueue } from '@project-vault/db/schema'
import { withTestOrg } from '@project-vault/db/test-helpers'
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

describe('notification deliver worker', () => {
  it('skips inbox channel without error', async () => {
    await withTestOrg(async ({ orgId }) => {
      const entryId = await insertPendingEntry(orgId, {
        orgId,
        recipientUserId: null,
        channel: 'inbox',
        templateId: 'security.failed_auth_threshold',
        payload: {},
        status: 'pending',
      })

      await expect(deliverNotification(entryId, orgId)).resolves.toBeUndefined()
      expect(await fetchQueueStatus(orgId, entryId)).toBe('pending')
    })
  })

  it('skips entries with future deliverAt', async () => {
    await withTestOrg(async ({ orgId }) => {
      const entryId = await insertPendingEntry(orgId, {
        orgId,
        channel: 'email',
        templateId: 'security.failed_auth_threshold',
        payload: {},
        status: 'pending',
        deliverAt: new Date(Date.now() + 3600_000),
      })

      await deliverNotification(entryId, orgId)
      expect(await fetchQueueStatus(orgId, entryId)).toBe('pending')
    })
  })
})
