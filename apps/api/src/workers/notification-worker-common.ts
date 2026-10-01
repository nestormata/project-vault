import { sql } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { withJobLogging } from '../lib/job-logging.js'
import type { BossService, BossJob } from '../lib/boss.js'
import type { FastifyBaseLogger } from 'fastify'

export const NOTIFICATION_MAX_ATTEMPTS = 5

/** Story 70.1 AC2 — the exclusive-claim lease. Must stay <= pg-boss's default queue
 * `expire_seconds` (900), so a hung job is expired by pg-boss no later than its lease, and below
 * NOTIFICATION_DLQ_GRACE_SECONDS, so the DLQ can never fail a row whose lease is still live. */
export const NOTIFICATION_CLAIM_LEASE_SECONDS = 900

/** Story 70.1 AC2 — how long after its last attempt an exhausted `pending` row waits before the
 * DLQ cleanup marks it `failed` (was the `'30 minutes'` literal in notification-dlq-cleanup.ts). */
export const NOTIFICATION_DLQ_GRACE_SECONDS = 1800

type WorkerLogger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>

export function createNotificationJobHandler(
  jobName: string,
  sendFn: (notificationQueueId: string, orgId: string, logger: WorkerLogger) => Promise<void>
) {
  return async function notificationJobHandler(job: BossJob, logger: WorkerLogger): Promise<void> {
    const notificationQueueId = job.data?.notificationQueueId
    const orgId = job.data?.orgId
    if (typeof notificationQueueId !== 'string' || typeof orgId !== 'string') {
      throw new TypeError(`${jobName} job missing notificationQueueId or orgId`)
    }
    // Story 28.6 AC3 — thread the job's logger down to the render call sites so a caught
    // template-render failure's error log (templateId + payload) actually fires in production,
    // not just when a test passes a logger in manually.
    await withJobLogging(logger, jobName, job.id ?? 'unknown', () =>
      sendFn(notificationQueueId, orgId, logger)
    )
  }
}

/**
 * Re-enqueues stale `pending` rows of every channel to `jobName`. Story 70.1 AC3: the only caller
 * is `notification/deliver-catchup` (the single catch-up owner). Rows with a live lease, a started
 * send (Decisions 2026-09-30), an exhausted attempt budget, a future `deliver_at`, or inside the
 * 5-minute grace are skipped; a backlog drains oldest-first. The per-org loop and per-org
 * `LIMIT 100` are deliberate (AC9 Red Team): one tenant's backlog cannot starve another's.
 */
export async function runNotificationCatchup(
  boss: BossService,
  options: { jobName: string; logMessage: string },
  logger: WorkerLogger
): Promise<void> {
  const { fetchAllOrgIds } = await import('../middleware/rls.js')
  const orgIds = await fetchAllOrgIds()
  let total = 0
  const { jobName, logMessage } = options

  for (const orgId of orgIds) {
    const staleEntries = await withOrg(orgId, (tx) =>
      tx.execute<{ id: string }>(sql`
        SELECT id::text AS id
        FROM notification_queue
        WHERE org_id = ${orgId}::uuid
          AND status = 'pending'
          AND attempt_count < ${NOTIFICATION_MAX_ATTEMPTS}
          AND (deliver_at IS NULL OR deliver_at <= NOW())
          AND (claim_expires_at IS NULL OR claim_expires_at <= NOW())
          AND send_started_at IS NULL
          AND created_at < NOW() - INTERVAL '5 minutes'
        ORDER BY created_at
        LIMIT 100
      `)
    )
    for (const entry of staleEntries) {
      await boss.send(
        jobName,
        { notificationQueueId: entry.id, orgId },
        {
          retryLimit: 3,
          retryBackoff: true,
          retryDelay: 60,
        }
      )
      total++
    }
  }

  if (total > 0) {
    logger.warn({ eventType: 'notification.catchup.entries_found', count: total }, logMessage)
  }
}
