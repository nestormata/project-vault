import { lt } from 'drizzle-orm'
import { getDb } from '@project-vault/db'
import { revokedTokens } from '@project-vault/db/schema'
import { runPruneJob, type WorkerLogger } from './prune-utils.js'

export async function pruneRevokedTokens(logger?: WorkerLogger): Promise<void> {
  await runPruneJob(
    'prune-revoked-tokens',
    () => getDb().delete(revokedTokens).where(lt(revokedTokens.expiresAt, new Date())),
    logger
  )
}
