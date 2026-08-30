import { describe, expect, it, vi } from 'vitest'
import { withOrg } from '@project-vault/db'
import { notificationQueue } from '@project-vault/db/schema'
import { withTestOrg } from '@project-vault/db/test-helpers'
import { createMockBoss } from '../__tests__/helpers/notification-test-helpers.js'
import { BossService } from '../lib/boss.js'
import {
  NOTIFICATION_MAX_ATTEMPTS,
  createNotificationJobHandler,
  runNotificationCatchup,
} from './notification-worker-common.js'

const FAILED_AUTH_TEMPLATE = 'security.failed_auth_threshold'
const NOTIFICATION_DELIVER_JOB = 'notification/deliver'

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
          jobName: NOTIFICATION_DELIVER_JOB,
          deliverAtAware: true,
          logMessage: 'Notification deliver catchup found stale pending entries',
        },
        logger
      )

      const orgCalls = send.mock.calls.filter((call) => call[1]?.orgId === orgId)
      expect(orgCalls).toHaveLength(1)
      expect(orgCalls[0]).toEqual([
        NOTIFICATION_DELIVER_JOB,
        { notificationQueueId: eligibleId, orgId },
        expect.objectContaining({ retryLimit: 3, retryDelay: 60 }),
      ])
    })
  })
})

describe('createNotificationJobHandler wired through BossService.registerWorker', () => {
  // Regression coverage for the production incident where every notification/email and
  // notification/deliver job failed with "missing notificationQueueId or orgId": pg-boss 12
  // invokes work() callbacks with a Job[] batch array (even at batchSize 1), and
  // BossService.registerWorker previously passed that array straight through instead of
  // unwrapping it — so job.data read off the array came back undefined. This drives the real
  // registration + job-handler chain (BossService + createNotificationJobHandler) with a
  // pg-boss-shaped batch array, the same way the actual worker is invoked in production.
  it('extracts notificationQueueId and orgId from a pg-boss batch-array delivery instead of throwing', async () => {
    const work = vi.fn().mockResolvedValue(undefined)
    const boss = new BossService(() => ({
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      createQueue: vi.fn().mockResolvedValue(undefined),
      work,
    }))
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const sendFn = vi.fn().mockResolvedValue(undefined)
    const jobHandler = createNotificationJobHandler(NOTIFICATION_DELIVER_JOB, sendFn)

    await boss.start()
    await boss.registerWorker(NOTIFICATION_DELIVER_JOB, (job) => jobHandler(job, logger))

    const registeredCallback = work.mock.calls[0]?.[1] as (job: unknown) => Promise<void>
    await registeredCallback([
      { id: 'job-1', data: { notificationQueueId: 'nq-1', orgId: 'org-1' } },
    ])

    expect(sendFn).toHaveBeenCalledWith('nq-1', 'org-1', logger)
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('throws when the unwrapped job is still missing notificationQueueId/orgId', async () => {
    const work = vi.fn().mockResolvedValue(undefined)
    const boss = new BossService(() => ({
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      createQueue: vi.fn().mockResolvedValue(undefined),
      work,
    }))
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const sendFn = vi.fn().mockResolvedValue(undefined)
    const jobHandler = createNotificationJobHandler(NOTIFICATION_DELIVER_JOB, sendFn)

    await boss.start()
    await boss.registerWorker(NOTIFICATION_DELIVER_JOB, (job) => jobHandler(job, logger))

    const registeredCallback = work.mock.calls[0]?.[1] as (job: unknown) => Promise<void>
    await expect(registeredCallback([{ id: 'job-2', data: {} }])).rejects.toThrow(
      'notification/deliver job missing notificationQueueId or orgId'
    )
    expect(sendFn).not.toHaveBeenCalled()
  })
})
