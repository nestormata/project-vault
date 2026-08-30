import { describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { register } from 'prom-client'
import { withOrg } from '@project-vault/db'
import { notificationQueue } from '@project-vault/db/schema'
import { withTwoTestOrgs } from '@project-vault/db/test-helpers'
import { getNotificationQueueEntry } from '../__tests__/helpers/notification-test-helpers.js'
import { NOTIFICATION_MAX_ATTEMPTS } from './notification-worker-common.js'
import { runNotificationDlqCleanup } from './notification-dlq-cleanup.js'
import {
  PGBOSS_DLQ_ENTRIES_TOTAL_METRIC_NAME,
  pgbossDlqEntriesTotal,
} from './notification-metrics.js'

const FAILED_AUTH_TEMPLATE_ID = 'security.failed_auth_threshold'

async function insertQueueEntry(
  orgId: string,
  values: Partial<typeof notificationQueue.$inferInsert> & { channel: 'email' | 'slack' | 'inbox' }
) {
  const [row] = await withOrg(orgId, (tx) =>
    tx
      .insert(notificationQueue)
      .values({
        orgId,
        templateId: FAILED_AUTH_TEMPLATE_ID,
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

  // Story 28.6 AC4 — architecture.md's existing pg-boss DLQ-monitoring rule (rotation:*/audit:*)
  // is extended to notification:* dead-letters: a per-row error log + pgboss_dlq_entries_total
  // counter increment, alongside (not instead of) the existing count-only summary warn log.
  it('increments pgboss_dlq_entries_total and emits a per-row error log for each exhausted entry', async () => {
    pgbossDlqEntriesTotal.reset()
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    await withTwoTestOrgs(async ({ orgAId }) => {
      const staleA1 = await insertQueueEntry(orgAId, {
        channel: 'email',
        templateId: FAILED_AUTH_TEMPLATE_ID,
        attemptCount: NOTIFICATION_MAX_ATTEMPTS,
        lastAttemptAt: new Date(Date.now() - 31 * 60 * 1000),
      })

      await runNotificationDlqCleanup(logger)

      const metric = await register.getSingleMetricAsString(PGBOSS_DLQ_ENTRIES_TOTAL_METRIC_NAME)
      expect(metric).toContain('job_type="notification"} 1')

      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'notification.dlq_cleanup.entry_failed',
          templateId: FAILED_AUTH_TEMPLATE_ID,
          notificationQueueId: staleA1,
        }),
        expect.any(String)
      )

      // Existing summary warn log still fires alongside the new per-row error log.
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'notification.dlq_cleanup.summary', count: 1 }),
        'Notification DLQ cleanup marked exhausted notification_queue entries failed'
      )
    })
  })

  it('does not increment the counter or log a per-row error when no exhausted entries exist', async () => {
    pgbossDlqEntriesTotal.reset()
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    await withTwoTestOrgs(async ({ orgAId }) => {
      await insertQueueEntry(orgAId, {
        channel: 'email',
        attemptCount: NOTIFICATION_MAX_ATTEMPTS - 1,
        lastAttemptAt: new Date(Date.now() - 20 * 60 * 1000),
      })

      await runNotificationDlqCleanup(logger)

      expect(logger.error).not.toHaveBeenCalled()
      const metric = await register.getSingleMetricAsString(PGBOSS_DLQ_ENTRIES_TOTAL_METRIC_NAME)
      expect(metric).not.toContain('job_type="notification"}')
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
