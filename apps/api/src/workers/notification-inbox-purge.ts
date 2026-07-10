import { lte } from 'drizzle-orm'
import { notificationInbox } from '@project-vault/db/schema'
import { getAdminDb } from '../lib/db.js'
import { withJobLogging } from '../lib/job-logging.js'
import type { FastifyBaseLogger } from 'fastify'

type PurgeLogger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>

export async function runInboxPurge(logger: PurgeLogger): Promise<void> {
  const now = new Date()
  const result = await getAdminDb()
    .delete(notificationInbox)
    .where(lte(notificationInbox.expiresAt, now))
    .returning({ id: notificationInbox.id })
  const deletedCount = result.length
  logger.info(
    { eventType: 'notification.inbox.purge.completed', deletedCount },
    'Inbox purge job completed'
  )
}

export async function notificationInboxPurgeHandler(logger: PurgeLogger): Promise<void> {
  await withJobLogging(logger, 'notification/inbox-purge', 'daily', () => runInboxPurge(logger))
}

export async function notificationInboxCatchupHandler(
  boss: import('../lib/boss.js').BossService,
  logger: PurgeLogger
): Promise<void> {
  const { runNotificationCatchup } = await import('./notification-worker-common.js')
  await runNotificationCatchup(
    boss,
    {
      channel: 'inbox',
      jobName: 'notification/deliver',
      logMessage: 'Notification catchup found stale pending inbox entries',
    },
    logger
  )
}
