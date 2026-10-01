import { describe, expect, it, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { notificationQueue } from '@project-vault/db/schema'
import { withTestOrg, withTwoTestOrgs } from '@project-vault/db/test-helpers'
import { createMockBoss } from '../__tests__/helpers/notification-test-helpers.js'
import { BossService } from '../lib/boss.js'
import {
  NOTIFICATION_CLAIM_LEASE_SECONDS,
  NOTIFICATION_DLQ_GRACE_SECONDS,
  NOTIFICATION_MAX_ATTEMPTS,
  createNotificationJobHandler,
} from './notification-worker-common.js'
import { runDeliverCatchup } from './notification-deliver-catchup.js'

describe('notification lease constants (Story 70.1 AC2)', () => {
  it('the claim lease is no longer than pg-boss expire_seconds and shorter than the DLQ grace', () => {
    expect(NOTIFICATION_CLAIM_LEASE_SECONDS).toBeLessThanOrEqual(900)
    expect(NOTIFICATION_CLAIM_LEASE_SECONDS).toBeLessThan(NOTIFICATION_DLQ_GRACE_SECONDS)
    expect(NOTIFICATION_DLQ_GRACE_SECONDS).toBe(1800)
  })
})

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

describe('runDeliverCatchup — the single catch-up owner (Story 70.1 AC3)', () => {
  async function runCatchupFor(orgId: string) {
    const { boss, send } = createMockBoss()
    await boss.start()
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    await runDeliverCatchup(boss, logger)
    return { calls: send.mock.calls.filter((call) => call[1]?.orgId === orgId), logger }
  }

  it('enqueues exactly one notification/deliver job per due row, every channel', async () => {
    await withTestOrg(async ({ orgId }) => {
      const ids = [
        await insertQueueEntry(orgId, { channel: 'email', templateId: FAILED_AUTH_TEMPLATE }),
        await insertQueueEntry(orgId, { channel: 'slack', templateId: FAILED_AUTH_TEMPLATE }),
        await insertQueueEntry(orgId, { channel: 'inbox', templateId: FAILED_AUTH_TEMPLATE }),
      ]

      const { calls, logger } = await runCatchupFor(orgId)

      expect(calls).toHaveLength(3)
      for (const call of calls) {
        expect(call[0]).toBe(NOTIFICATION_DELIVER_JOB)
        expect(call[2]).toEqual(
          expect.objectContaining({ retryLimit: 3, retryBackoff: true, retryDelay: 60 })
        )
      }
      expect(calls.map((call) => call[1].notificationQueueId).sort()).toEqual([...ids].sort())
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'notification.catchup.entries_found' }),
        'Notification deliver catchup found stale pending entries'
      )
    })
  })

  it('skips rows with a live lease, a future deliver_at, a maxed attempt budget, a started send, or inside the 5-minute grace', async () => {
    await withTestOrg(async ({ orgId }) => {
      const eligibleId = await insertQueueEntry(orgId, {
        channel: 'email',
        templateId: FAILED_AUTH_TEMPLATE,
        attemptCount: NOTIFICATION_MAX_ATTEMPTS - 1,
        deliverAt: new Date(Date.now() - 60_000),
      })
      const leasedId = await insertQueueEntry(orgId, {
        channel: 'email',
        templateId: FAILED_AUTH_TEMPLATE,
      })
      await withOrg(orgId, (tx) =>
        tx.execute(sql`
          UPDATE notification_queue SET claim_expires_at = now() + interval '10 minutes'
           WHERE id = ${leasedId}::uuid
        `)
      )
      const sendStartedId = await insertQueueEntry(orgId, {
        channel: 'email',
        templateId: FAILED_AUTH_TEMPLATE,
      })
      await withOrg(orgId, (tx) =>
        tx.execute(sql`
          UPDATE notification_queue
             SET claim_expires_at = now() - interval '1 second', send_started_at = now()
           WHERE id = ${sendStartedId}::uuid
        `)
      )
      await insertQueueEntry(orgId, {
        channel: 'inbox',
        templateId: FAILED_AUTH_TEMPLATE,
        deliverAt: new Date(Date.now() + 3_600_000),
      })
      await insertQueueEntry(orgId, {
        channel: 'inbox',
        templateId: FAILED_AUTH_TEMPLATE,
        attemptCount: NOTIFICATION_MAX_ATTEMPTS,
      })
      await insertQueueEntry(orgId, {
        channel: 'slack',
        templateId: FAILED_AUTH_TEMPLATE,
        createdAt: new Date(Date.now() - 4 * 60 * 1000),
      })

      const { calls } = await runCatchupFor(orgId)

      expect(calls.map((call) => call[1].notificationQueueId)).toEqual([eligibleId])
    })
  })

  it('re-enqueues a row whose lease has expired (crash recovery)', async () => {
    await withTestOrg(async ({ orgId }) => {
      const expiredId = await insertQueueEntry(orgId, {
        channel: 'email',
        templateId: FAILED_AUTH_TEMPLATE,
        attemptCount: 1,
      })
      await withOrg(orgId, (tx) =>
        tx.execute(sql`
          UPDATE notification_queue SET claim_expires_at = now() - interval '1 second'
           WHERE id = ${expiredId}::uuid
        `)
      )

      const { calls } = await runCatchupFor(orgId)

      expect(calls.map((call) => call[1].notificationQueueId)).toEqual([expiredId])
    })
  })

  it('drains a backlog oldest-first: 150 due rows enqueue the 100 oldest', async () => {
    await withTestOrg(async ({ orgId }) => {
      const base = Date.now() - 2 * 60 * 60 * 1000
      const rows = Array.from({ length: 150 }, (_, i) => ({
        orgId,
        channel: 'email' as const,
        templateId: FAILED_AUTH_TEMPLATE,
        payload: {},
        status: 'pending',
        createdAt: new Date(base + i * 1000),
      }))
      const inserted = await withOrg(orgId, (tx) =>
        tx
          .insert(notificationQueue)
          .values(rows)
          .returning({ id: notificationQueue.id, createdAt: notificationQueue.createdAt })
      )
      const oldest = inserted
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .slice(0, 100)
        .map((r) => r.id)

      const { calls } = await runCatchupFor(orgId)

      expect(calls).toHaveLength(100)
      expect(calls.map((call) => call[1].notificationQueueId).sort()).toEqual([...oldest].sort())
    })
  })

  it('pairs every job with its own row’s org (tenant isolation)', async () => {
    await withTwoTestOrgs(async ({ orgAId, orgBId }) => {
      const rowA = await insertQueueEntry(orgAId, {
        channel: 'email',
        templateId: FAILED_AUTH_TEMPLATE,
      })
      const rowB = await insertQueueEntry(orgBId, {
        channel: 'slack',
        templateId: FAILED_AUTH_TEMPLATE,
      })
      const { boss, send } = createMockBoss()
      await boss.start()
      await runDeliverCatchup(boss, { info: vi.fn(), warn: vi.fn(), error: vi.fn() })

      const pairs = send.mock.calls
        .map((call) => call[1] as { notificationQueueId: string; orgId: string })
        .filter((data) => [rowA, rowB].includes(data.notificationQueueId))
      expect(pairs).toEqual(
        expect.arrayContaining([
          { notificationQueueId: rowA, orgId: orgAId },
          { notificationQueueId: rowB, orgId: orgBId },
        ])
      )
      expect(pairs).toHaveLength(2)
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
