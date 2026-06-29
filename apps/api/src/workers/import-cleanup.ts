import { lt } from 'drizzle-orm'
import { pendingImports } from '@project-vault/db/schema'
import { OperationalEvent } from '@project-vault/shared'
import type { FastifyBaseLogger } from 'fastify'
import { getAdminDb } from '../lib/db.js'
import { operationalLog } from '../lib/logger.js'

type WorkerLogger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>

export const IMPORT_CLEANUP_JOB = 'import/cleanup-expired'

export async function importCleanupExpired(logger?: WorkerLogger): Promise<void> {
  const result = await getAdminDb()
    .delete(pendingImports)
    .where(lt(pendingImports.expiresAt, new Date()))
    .returning({ id: pendingImports.id })

  if (logger) {
    operationalLog(
      logger,
      'info',
      OperationalEvent.CREDENTIAL_IMPORT_CLEANUP_RUN,
      'import:cleanup-expired completed',
      {
        deletedCount: result.length,
        deletedIds: result.map((row) => row.id),
      }
    )
  }
}
