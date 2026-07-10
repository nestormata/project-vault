import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { notificationQueue } from '@project-vault/db/schema'
import { withTestOrg } from '@project-vault/db/test-helpers'
import { markNotificationSuppressed } from './notification-queue-ops.js'

async function insertQueueEntry(
  orgId: string,
  status: 'pending' | 'delivered' | 'failed' | 'suppressed'
) {
  const [row] = await withOrg(orgId, (tx) =>
    tx
      .insert(notificationQueue)
      .values({
        orgId,
        channel: 'email',
        templateId: 'security.failed_auth_threshold',
        payload: {},
        status,
      })
      .returning({ id: notificationQueue.id })
  )
  if (!row) throw new Error('expected queue row')
  return row.id
}

describe('notification queue ops', () => {
  it('marks pending entries suppressed', async () => {
    await withTestOrg(async ({ orgId }) => {
      const queueId = await insertQueueEntry(orgId, 'pending')

      await markNotificationSuppressed(queueId, orgId)

      const [updated] = await withOrg(orgId, (tx) =>
        tx.select().from(notificationQueue).where(eq(notificationQueue.id, queueId))
      )
      expect(updated?.status).toBe('suppressed')
    })
  })

  it('does not overwrite failed entries when suppression runs late', async () => {
    await withTestOrg(async ({ orgId }) => {
      const queueId = await insertQueueEntry(orgId, 'failed')

      await markNotificationSuppressed(queueId, orgId)

      const [updated] = await withOrg(orgId, (tx) =>
        tx.select().from(notificationQueue).where(eq(notificationQueue.id, queueId))
      )
      expect(updated?.status).toBe('failed')
    })
  })
})
