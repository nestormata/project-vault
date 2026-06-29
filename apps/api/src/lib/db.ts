import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'

let _adminDb: ReturnType<typeof drizzle> | null = null

export function getAdminDb(): ReturnType<typeof drizzle> {
  if (!_adminDb) {
    const url =
      process.env['ADMIN_DATABASE_URL'] ??
      'postgresql://postgres:password@localhost:5432/project_vault'
    const pgClient = postgres(url)
    _adminDb = drizzle(pgClient)
  }
  return _adminDb
}
