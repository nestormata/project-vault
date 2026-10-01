import { sql } from 'drizzle-orm'
import { OperationalEvent } from '@project-vault/shared'
import { withOrg } from '@project-vault/db'
import type { FastifyBaseLogger } from 'fastify'
import { fetchAllOrgIds } from '../middleware/rls.js'
import { operationalLog } from '../lib/logger.js'
import { markNotificationFailed } from './notification-queue-ops.js'
import {
  NOTIFICATION_DLQ_GRACE_SECONDS,
  NOTIFICATION_MAX_ATTEMPTS,
} from './notification-worker-common.js'
import {
  notificationDeliveryOutcomeUnknownTotal,
  pgbossDlqEntriesTotal,
} from './notification-metrics.js'

type DlqCleanupLogger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>

type OutcomeUnknownRow = {
  id: string
  template_id: string
  channel: string
  attempt_count: number
}

/**
 * Story 70.1 Decisions 2026-09-30 (DW-252) — at-most-once for an ambiguous send outcome: a
 * `pending` row whose send started (`send_started_at` set) and whose lease has expired was either
 * interrupted mid-send or had its status commit fail after a resolved send. It is never re-sent;
 * it is moved to `failed` here, with its own recipient-free error log and counter (plus the
 * existing DLQ counter). Returns how many rows this call actually transitioned.
 */
async function failOutcomeUnknownSends(orgId: string, logger?: DlqCleanupLogger): Promise<number> {
  const rows = await withOrg(orgId, (tx) =>
    tx.execute<OutcomeUnknownRow>(sql`
      SELECT id::text AS id, template_id, channel, attempt_count
      FROM notification_queue
      WHERE org_id = ${orgId}::uuid
        AND status = 'pending'
        AND send_started_at IS NOT NULL
        AND (claim_expires_at IS NULL OR claim_expires_at <= NOW())
    `)
  )

  let count = 0
  for (const row of rows) {
    if (!(await markNotificationFailed(row.id, orgId))) continue
    count++
    notificationDeliveryOutcomeUnknownTotal.inc({ channel: row.channel })
    pgbossDlqEntriesTotal.inc({ job_type: 'notification' })
    if (logger) {
      operationalLog(
        logger,
        'error',
        OperationalEvent.NOTIFICATION_DELIVERY_OUTCOME_UNKNOWN,
        'Notification send outcome unknown (interrupted or unrecorded); marked failed, not re-sent',
        {
          notificationQueueId: row.id,
          templateId: row.template_id,
          channel: row.channel,
          attemptNumber: row.attempt_count,
        }
      )
    }
  }
  return count
}

export async function runNotificationDlqCleanup(logger?: DlqCleanupLogger): Promise<void> {
  const orgIds = await fetchAllOrgIds()
  let count = 0

  for (const orgId of orgIds) {
    count += await failOutcomeUnknownSends(orgId, logger)

    // Rows with a started send are owned by failOutcomeUnknownSends above (their own reason),
    // never by the ordinary exhausted-attempts dead-letter below.
    const rows = await withOrg(orgId, (tx) =>
      tx.execute<{ id: string; template_id: string }>(sql`
        SELECT id::text AS id, template_id
        FROM notification_queue
        WHERE org_id = ${orgId}::uuid
          AND status = 'pending'
          AND attempt_count >= ${NOTIFICATION_MAX_ATTEMPTS}
          AND send_started_at IS NULL
          AND last_attempt_at < NOW() - (${NOTIFICATION_DLQ_GRACE_SECONDS} * INTERVAL '1 second')
      `)
    )

    for (const row of rows) {
      if (await markNotificationFailed(row.id, orgId)) {
        count++
        // Story 28.6 AC4 — per-row operational visibility (counter + error log) on top of, not
        // instead of, the existing count-only summary below, so a permanently-undeliverable
        // notification is traceable back to its poison payload without a manual DB query.
        pgbossDlqEntriesTotal.inc({ job_type: 'notification' })
        if (logger) {
          operationalLog(
            logger,
            'error',
            OperationalEvent.NOTIFICATION_DLQ_ENTRY_FAILED,
            'Notification permanently dead-lettered after exhausting retry attempts',
            { templateId: row.template_id, notificationQueueId: row.id }
          )
        }
      }
    }
  }

  if (count > 0 && logger) {
    operationalLog(
      logger,
      'warn',
      OperationalEvent.NOTIFICATION_DLQ_CLEANUP_SUMMARY,
      'Notification DLQ cleanup marked exhausted notification_queue entries failed',
      { count }
    )
  }
}
