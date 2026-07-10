import { sql } from 'drizzle-orm'
import { OperationalEvent } from '@project-vault/shared'
import { withOrg } from '@project-vault/db'
import type { FastifyBaseLogger } from 'fastify'
import { fetchAllOrgIds } from '../middleware/rls.js'
import { operationalLog } from '../lib/logger.js'
import { markNotificationFailed } from './notification-queue-ops.js'
import { NOTIFICATION_MAX_ATTEMPTS } from './notification-worker-common.js'

type DlqCleanupLogger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>

export async function runNotificationDlqCleanup(logger?: DlqCleanupLogger): Promise<void> {
  const orgIds = await fetchAllOrgIds()
  let count = 0

  for (const orgId of orgIds) {
    const rows = await withOrg(orgId, (tx) =>
      tx.execute<{ id: string }>(sql`
        SELECT id::text AS id
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
