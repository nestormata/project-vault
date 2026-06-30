import { sql } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { securityAlerts } from '@project-vault/db/schema'
import { eq } from 'drizzle-orm'
import { fetchAllOrgIds } from '../middleware/rls.js'
import {
  createOrgAdminNotificationEntries,
  sendNotificationJobs,
} from '../notifications/dispatcher.js'
import type { BossService } from '../lib/boss.js'

type AlertRow = {
  id: string
  org_id: string
  alert_type: string
  payload: Record<string, unknown>
}

export async function runNotificationBackfill(
  boss: BossService,
  logger: Pick<import('fastify').FastifyBaseLogger, 'info' | 'warn' | 'error'>
): Promise<void> {
  const orgIds = await fetchAllOrgIds()
  let totalProcessed = 0

  for (const orgId of orgIds) {
    const pendingAlerts = await withOrg(orgId, async (tx) =>
      tx.execute<AlertRow>(sql`
        SELECT id::text AS id,
               org_id::text AS org_id,
               alert_type,
               payload
        FROM security_alerts
        WHERE org_id = ${orgId}::uuid
          AND status = 'PENDING_DELIVERY'
        ORDER BY created_at ASC
      `)
    )

    for (const alert of pendingAlerts) {
      try {
        const queueIds = await withOrg(orgId, async (tx) => {
          const ids = await createOrgAdminNotificationEntries({
            orgId,
            template: {
              templateId: alert.alert_type,
              payload: alert.payload,
            },
            tx,
          })
          await tx
            .update(securityAlerts)
            .set({ status: 'delivered' })
            .where(eq(securityAlerts.id, alert.id))
          return ids
        })
        await sendNotificationJobs(boss, queueIds)
        totalProcessed++
      } catch (err) {
        logger.error(
          {
            eventType: 'notification.backfill.error',
            alertId: alert.id,
            orgId,
            err,
          },
          'Failed to backfill PENDING_DELIVERY alert'
        )
      }
    }
  }

  if (totalProcessed > 0) {
    logger.info(
      {
        eventType: 'notification.backfill.completed',
        totalProcessed,
      },
      `Backfill processed ${totalProcessed} PENDING_DELIVERY alerts`
    )
  }
}

export async function notificationBackfillHandler(
  boss: BossService,
  logger: Pick<import('fastify').FastifyBaseLogger, 'info' | 'warn' | 'error'>
): Promise<void> {
  try {
    await runNotificationBackfill(boss, logger)
  } catch (err) {
    logger.error(
      {
        eventType: 'notification.backfill.failed',
        err,
      },
      'Notification backfill job failed'
    )
    throw err
  }
}
