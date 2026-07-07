import { withJobLogging } from '../lib/job-logging.js'
import type { BossService } from '../lib/boss.js'
import type { FastifyBaseLogger } from 'fastify'
import { runNotificationCatchup } from './notification-worker-common.js'

export async function runDeliverCatchup(
  boss: BossService,
  logger: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>
): Promise<void> {
  await runNotificationCatchup(
    boss,
    {
      jobName: 'notification/deliver',
      deliverAtAware: true,
      logMessage: 'Notification deliver catchup found stale pending entries',
    },
    logger
  )
}

export async function notificationDeliverCatchupJobHandler(
  boss: BossService,
  logger: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>
): Promise<void> {
  await withJobLogging(logger, 'notification/deliver-catchup', 'scheduled', () =>
    runDeliverCatchup(boss, logger)
  )
}
