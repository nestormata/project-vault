import { gte, lt, or, sql } from 'drizzle-orm'
import { getDb } from '@project-vault/db'
import { pendingMfaSessions } from '@project-vault/db/schema'
import { env } from '../config/env.js'
import { runPruneJob, type WorkerLogger } from './prune-utils.js'

export async function prunePendingMfaSessions(logger?: WorkerLogger): Promise<void> {
  await runPruneJob(
    'mfa:prune-pending-mfa-sessions',
    () =>
      getDb()
        .delete(pendingMfaSessions)
        .where(
          or(
            lt(pendingMfaSessions.expiresAt, sql`NOW()`),
            gte(pendingMfaSessions.attemptCount, env.MFA_LOGIN_MAX_ATTEMPTS)
          )
        )
        .returning({ id: pendingMfaSessions.id }),
    logger
  )
}
