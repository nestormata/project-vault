import { sql } from 'drizzle-orm'
import { OperationalEvent } from '@project-vault/shared'
import { withOrg } from '@project-vault/db'
import type { FastifyBaseLogger } from 'fastify'
import { fetchAllOrgIds } from '../middleware/rls.js'
import { operationalLog } from '../lib/logger.js'
import { markNotificationFailed } from './notification-queue-ops.js'
import { NOTIFICATION_MAX_ATTEMPTS } from './notification-worker-common.js'
import { pgbossDlqEntriesTotal } from './notification-metrics.js'

type DlqCleanupLogger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>

export async function runNotificationDlqCleanup(logger?: DlqCleanupLogger): Promise<void> {
  const orgIds = await fetchAllOrgIds()
  let count = 0

  for (const orgId of orgIds) {
    const rows = await withOrg(orgId, (tx) =>
      tx.execute<{ id: string; template_id: string }>(sql`
        SELECT id::text AS id, template_id
        FROM notification_queue
        WHERE org_id = ${orgId}::uuid
          AND status = 'pending'
          AND attempt_count >= ${NOTIFICATION_MAX_ATTEMPTS}
          AND last_attempt_at < NOW() - INTERVAL '30 minutes'
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
