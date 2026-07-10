import { describe, expect, it, vi } from 'vitest'
import { withOrg } from '@project-vault/db'
import { notificationQueue } from '@project-vault/db/schema'
import { withTestOrg } from '@project-vault/db/test-helpers'
import { createMockBoss } from '../__tests__/helpers/notification-test-helpers.js'
import { NOTIFICATION_MAX_ATTEMPTS, runNotificationCatchup } from './notification-worker-common.js'

const FAILED_AUTH_TEMPLATE = 'security.failed_auth_threshold'

async function insertQueueEntry(
  orgId: string,
  values: Partial<typeof notificationQueue.$inferInsert> & {
    channel: 'email' | 'slack' | 'inbox'
    templateId: string
  }
) {
  const [row] = await withOrg(orgId, (tx) =>
    tx
      .insert(notificationQueue)
      .values({
        orgId,
        payload: {},
        status: 'pending',
        createdAt: new Date(Date.now() - 10 * 60 * 1000),
        ...values,
      })
      .returning({ id: notificationQueue.id })
  )
  if (!row) throw new Error('expected notification queue row')
  return row.id
}

describe('runNotificationCatchup', () => {
  it('re-enqueues stale channel-specific pending entries still below the max attempt budget', async () => {
    const { boss, send } = createMockBoss()
    await boss.start()
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    await withTestOrg(async ({ orgId }) => {
      const eligibleId = await insertQueueEntry(orgId, {
        channel: 'email',
        templateId: FAILED_AUTH_TEMPLATE,
        attemptCount: NOTIFICATION_MAX_ATTEMPTS - 1,
      })
      await insertQueueEntry(orgId, {
        channel: 'email',
        templateId: FAILED_AUTH_TEMPLATE,
        attemptCount: NOTIFICATION_MAX_ATTEMPTS,
      })

      await runNotificationCatchup(
        boss,
        {
          jobName: 'notification/email',
          channel: 'email',
          logMessage: 'Notification catchup found stale pending email entries',
        },
        logger
      )

      const orgCalls = send.mock.calls.filter((call) => call[1]?.orgId === orgId)
      expect(orgCalls).toHaveLength(1)
      expect(orgCalls[0]).toEqual([
        'notification/email',
        { notificationQueueId: eligibleId, orgId },
        expect.objectContaining({ retryLimit: 3, retryDelay: 60 }),
      ])
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'notification.catchup.entries_found' }),
        'Notification catchup found stale pending email entries'
      )
    })
  })

  it('also excludes maxed-out entries from the deliverAt-aware catchup branch', async () => {
    const { boss, send } = createMockBoss()
    await boss.start()
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    await withTestOrg(async ({ orgId }) => {
      const eligibleId = await insertQueueEntry(orgId, {
        channel: 'inbox',
        templateId: FAILED_AUTH_TEMPLATE,
        attemptCount: NOTIFICATION_MAX_ATTEMPTS - 2,
        deliverAt: new Date(Date.now() - 60_000),
      })
      await insertQueueEntry(orgId, {
        channel: 'inbox',
        templateId: FAILED_AUTH_TEMPLATE,
        attemptCount: NOTIFICATION_MAX_ATTEMPTS,
        deliverAt: new Date(Date.now() - 60_000),
      })

      await runNotificationCatchup(
        boss,
        {
          jobName: 'notification/deliver',
          deliverAtAware: true,
          logMessage: 'Notification deliver catchup found stale pending entries',
        },
        logger
      )

      const orgCalls = send.mock.calls.filter((call) => call[1]?.orgId === orgId)
      expect(orgCalls).toHaveLength(1)
      expect(orgCalls[0]).toEqual([
        'notification/deliver',
        { notificationQueueId: eligibleId, orgId },
        expect.objectContaining({ retryLimit: 3, retryDelay: 60 }),
      ])
    })
  })
})
