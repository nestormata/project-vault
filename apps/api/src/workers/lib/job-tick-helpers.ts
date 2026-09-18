import { sql } from 'drizzle-orm'
import { getDb } from '@project-vault/db'
import { OperationalEvent } from '@project-vault/shared'

type OperationalEventValue = (typeof OperationalEvent)[keyof typeof OperationalEvent]
import { operationalLog } from '../../lib/logger.js'
import type { WorkerLogger } from '../expiry-alert-shared.js'

/** The transaction handle a `getDb().transaction(...)` callback receives, shared so callers of
 * `runAdvisoryLockedTick` can type their tick body without re-deriving it themselves. */
export type DbTransaction = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0]

/**
 * Shared "at most one tick at a time" wrapper, extracted from `monitoring-health-check.ts` and
 * `extension-scheduled-tasks.ts` (both independently implemented the identical
 * `pg_try_advisory_xact_lock`-in-a-transaction pattern per this story's own Dev Notes instruction
 * to mirror that worker's shape — jscpd flagged the resulting duplication).
 *
 * Wraps `body` in a single transaction that also holds the non-blocking advisory lock keyed by
 * `lockName`: if another tick already holds it, `body` is skipped entirely and `skippedMessage` is
 * logged (via `logger`, when provided) against `skippedEvent`; otherwise `body` runs with the same
 * `lockTx` the lock was acquired on, and the lock is released automatically when the transaction
 * ends (commit, rollback, or an uncaught error) — see `runHealthCheckTick`'s own doc comment for
 * why the lock must be transaction-scoped rather than session-scoped against a pooled connection.
 */
export async function runAdvisoryLockedTick(
  lockName: string,
  logger: WorkerLogger | undefined,
  skippedEvent: OperationalEventValue,
  skippedMessage: string,
  body: (lockTx: DbTransaction) => Promise<void>
): Promise<void> {
  await getDb().transaction(async (lockTx) => {
    const lockRows = await lockTx.execute<{ locked: boolean }>(
      sql`SELECT pg_try_advisory_xact_lock(hashtext(${lockName})) AS locked`
    )
    const acquired = Boolean(lockRows[0]?.locked)
    if (!acquired) {
      if (logger) {
        operationalLog(logger, 'warn', skippedEvent, skippedMessage, {})
      }
      return
    }

    await body(lockTx)
  })
}

/**
 * Shared job-tick entrypoint wrapper, extracted from `monitoring-health-check.ts`'s
 * `healthCheckTickHandler` and `extension-scheduled-tasks.ts`'s `scheduledTasksTickHandler`:
 * runs `tick`, and on a thrown error emits the `job.failed` structured line the job runner scrapes
 * from stderr before rethrowing (so the job runner's own failure handling still sees the error).
 */
export async function runTickHandler(jobName: string, tick: () => Promise<void>): Promise<void> {
  try {
    await tick()
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ eventType: 'job.failed', job: jobName, error: error instanceof Error ? error.message : String(error) })}\n`
    )
    throw error
  }
}
