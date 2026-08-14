import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { env } from '../config/env.js'

let _adminDb: ReturnType<typeof drizzle> | null = null

/**
 * The shared admin pool is a non-superuser `BYPASSRLS` role with an explicit table grant set.
 * It exists for reviewed cross-org/pre-auth lookups and maintenance writes; it is not the
 * RLS-bound application pool (`getDb()`), and it is not a containment boundary for in-process
 * extensions. Story 24.2 tracks its remaining consumers and the long-term decomposition.
 */
export function getAdminDb(): ReturnType<typeof drizzle> {
  if (!_adminDb) {
    if (!env.ADMIN_DATABASE_URL) {
      throw new Error('ADMIN_DATABASE_URL is required before creating the admin database pool')
    }
    const pgClient = postgres(env.ADMIN_DATABASE_URL)
    _adminDb = drizzle(pgClient)
  }
  return _adminDb
}
