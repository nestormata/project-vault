import { lt } from 'drizzle-orm'
import { getDb } from '@project-vault/db'
import { revokedTokens } from '@project-vault/db/schema'

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

export async function pruneRevokedTokens(logger: WorkerLogger = defaultLogger): Promise<void> {
  try {
    const result = await getDb()
      .delete(revokedTokens)
      .where(lt(revokedTokens.expiresAt, new Date()))
    logger.info({
      eventType: 'job.completed',
      jobName: 'prune-revoked-tokens',
      deletedCount: deletedCountFromResult(result),
    })
  } catch (err) {
    logger.error({ eventType: 'job.failed', jobName: 'prune-revoked-tokens', err })
    throw err
  }
}
