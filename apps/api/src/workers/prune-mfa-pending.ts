import { and, eq, lt } from 'drizzle-orm'
import { getDb } from '@project-vault/db'
import { mfaEnrollments } from '@project-vault/db/schema'
import { runPruneJob, type WorkerLogger } from './prune-utils.js'

export async function pruneMfaPendingEnrollments(logger?: WorkerLogger): Promise<void> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000)
  await runPruneJob(
    'mfa/prune-pending',
    () =>
      getDb()
        .delete(mfaEnrollments)
        .where(and(eq(mfaEnrollments.status, 'pending'), lt(mfaEnrollments.createdAt, cutoff))),
    logger
  )
}
