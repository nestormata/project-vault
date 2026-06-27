import { and, eq, lt } from 'drizzle-orm'
import { getDb } from '@project-vault/db'
import { mfaEnrollments } from '@project-vault/db/schema'

type WorkerLogger = {
  info: (payload: unknown) => void
  error: (payload: unknown) => void
}

const defaultLogger: WorkerLogger = {
  info: (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`),
  error: (payload) => process.stderr.write(`${JSON.stringify(payload)}\n`),
}

function deletedCountFromResult(result: unknown): number {
  if (result && typeof result === 'object' && 'rowCount' in result) {
    return Number((result as { rowCount?: unknown }).rowCount ?? 0)
  }
  return 0
}

export async function pruneMfaPendingEnrollments(
  logger: WorkerLogger = defaultLogger
): Promise<void> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000)
  try {
    const result = await getDb()
      .delete(mfaEnrollments)
      .where(and(eq(mfaEnrollments.status, 'pending'), lt(mfaEnrollments.createdAt, cutoff)))
    logger.info({
      eventType: 'job.completed',
      jobName: 'mfa:prune-pending',
      deletedCount: deletedCountFromResult(result),
    })
  } catch (err) {
    logger.error({ eventType: 'job.failed', jobName: 'mfa:prune-pending', err })
    throw err
  }
}
