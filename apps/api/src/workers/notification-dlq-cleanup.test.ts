import { describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { notificationQueue } from '@project-vault/db/schema'
import { withTwoTestOrgs } from '@project-vault/db/test-helpers'
import { getNotificationQueueEntry } from '../__tests__/helpers/notification-test-helpers.js'
import { NOTIFICATION_MAX_ATTEMPTS } from './notification-worker-common.js'
import { runNotificationDlqCleanup } from './notification-dlq-cleanup.js'

async function insertQueueEntry(
  orgId: string,
  values: Partial<typeof notificationQueue.$inferInsert> & { channel: 'email' | 'slack' | 'inbox' }
) {
  const [row] = await withOrg(orgId, (tx) =>
    tx
      .insert(notificationQueue)
      .values({
        orgId,
        templateId: 'security.failed_auth_threshold',
        payload: {},
        status: 'pending',
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
        ...values,
      })
      .returning({ id: notificationQueue.id })
  )
  if (!row) throw new Error('expected notification queue row')
  return row.id
}

describe('runNotificationDlqCleanup', () => {
  it('marks exhausted stale pending entries failed across orgs and logs a warning summary', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    await withTwoTestOrgs(async ({ orgAId, orgBId }) => {
      const staleA1 = await insertQueueEntry(orgAId, {
        channel: 'email',
        attemptCount: NOTIFICATION_MAX_ATTEMPTS,
        lastAttemptAt: new Date(Date.now() - 31 * 60 * 1000),
      })
      const staleA2 = await insertQueueEntry(orgAId, {
        channel: 'inbox',
        attemptCount: NOTIFICATION_MAX_ATTEMPTS + 1,
        lastAttemptAt: new Date(Date.now() - 35 * 60 * 1000),
      })
      const staleB = await insertQueueEntry(orgBId, {
        channel: 'slack',
        attemptCount: NOTIFICATION_MAX_ATTEMPTS,
        lastAttemptAt: new Date(Date.now() - 40 * 60 * 1000),
      })
      await insertQueueEntry(orgBId, {
        channel: 'email',
        attemptCount: NOTIFICATION_MAX_ATTEMPTS - 1,
        lastAttemptAt: new Date(Date.now() - 40 * 60 * 1000),
      })

      await runNotificationDlqCleanup(logger)

      expect((await getNotificationQueueEntry(orgAId, staleA1))?.status).toBe('failed')
      expect((await getNotificationQueueEntry(orgAId, staleA2))?.status).toBe('failed')
      expect((await getNotificationQueueEntry(orgBId, staleB))?.status).toBe('failed')
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'notification.dlq_cleanup.summary',
          count: 3,
        }),
        'Notification DLQ cleanup marked exhausted notification_queue entries failed'
      )
    })
  })

  it('does not log or update anything when no exhausted stale entries exist', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    await withTwoTestOrgs(async ({ orgAId, orgBId }) => {
      await insertQueueEntry(orgAId, {
        channel: 'email',
        attemptCount: NOTIFICATION_MAX_ATTEMPTS - 1,
        lastAttemptAt: new Date(Date.now() - 20 * 60 * 1000),
      })
      await insertQueueEntry(orgBId, {
        channel: 'inbox',
        attemptCount: 1,
        lastAttemptAt: new Date(Date.now() - 10 * 60 * 1000),
      })

      await expect(runNotificationDlqCleanup(logger)).resolves.toBeUndefined()

      expect(logger.warn).not.toHaveBeenCalled()
      expect(logger.info).not.toHaveBeenCalled()
    })
  })

  it('leaves a row delivered if it no longer has pending status by cleanup time', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    await withTwoTestOrgs(async ({ orgAId }) => {
      const queueId = await insertQueueEntry(orgAId, {
        channel: 'email',
        attemptCount: NOTIFICATION_MAX_ATTEMPTS,
        lastAttemptAt: new Date(Date.now() - 31 * 60 * 1000),
      })
      await withOrg(orgAId, (tx) =>
        tx
          .update(notificationQueue)
          .set({ status: 'delivered' })
          .where(eq(notificationQueue.id, queueId))
      )

      await runNotificationDlqCleanup(logger)

      expect((await getNotificationQueueEntry(orgAId, queueId))?.status).toBe('delivered')
    })
  })
})
