import { lt } from 'drizzle-orm'
import { getDb } from '@project-vault/db'
import { totpUsedCodes } from '@project-vault/db/schema'
import { runPruneJob, type WorkerLogger } from './prune-utils.js'

export async function pruneTotpUsedCodes(logger?: WorkerLogger): Promise<void> {
  await runPruneJob(
    'mfa/prune-totp-used-codes',
    () => getDb().delete(totpUsedCodes).where(lt(totpUsedCodes.expiresAt, new Date())),
    logger
  )
}
