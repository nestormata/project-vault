import { sql } from 'drizzle-orm'
import { getDb } from '@project-vault/db'
import { failedAuthAttempts } from '@project-vault/db/schema'
import { env } from '../config/env.js'

export async function pruneFailedAuthAttempts(): Promise<void> {
  await getDb()
    .delete(failedAuthAttempts)
    .where(
      sql`${failedAuthAttempts.attemptedAt} < NOW() - (${env.FAILED_AUTH_RETENTION_HOURS} || ' hours')::interval`
    )
}
