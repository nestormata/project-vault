import { withJobLogging } from '../lib/job-logging.js'
import type { BossService } from '../lib/boss.js'
import type { FastifyBaseLogger } from 'fastify'
import { runNotificationCatchup } from './notification-worker-common.js'

/**
 * Story 70.1 AC3 — the per-channel catch-up schedules that overlapped `notification/deliver-catchup`
 * (every stale row got two jobs per tick). A pg-boss schedule row persists across deploys, so
 * removing a key from `registerSchedules` does not stop the cron: main.ts unschedules each of these
 * explicitly at boot (idempotent — a no-op once gone). `notification/deliver-catchup` is now the
 * single catch-up owner for every channel.
 */
export const RETIRED_NOTIFICATION_CATCHUP_SCHEDULES = [
  'notification/email-catchup',
  'notification/slack-catchup',
  'notification/inbox-catchup',
] as const

export async function runDeliverCatchup(
  boss: BossService,
  logger: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>
): Promise<void> {
  await runNotificationCatchup(
    boss,
    {
      jobName: 'notification/deliver',
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
