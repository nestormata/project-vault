import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'

export type Tx = Parameters<Parameters<ReturnType<typeof drizzle>['transaction']>[0]>[0]

let _db: ReturnType<typeof drizzle> | null = null

export function getDb(): ReturnType<typeof drizzle> {
  if (!_db) {
    const pgClient = postgres(
      process.env['DATABASE_URL'] ?? 'postgresql://postgres:password@localhost:5432/project_vault'
    )
    _db = drizzle(pgClient)
  }
  return _db
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function withOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  // Validate before reaching set_config() — an invalid UUID causes a confusing
  // PostgreSQL cast error at the RLS policy layer rather than a clear application error.
  if (!UUID_REGEX.test(orgId)) {
    throw new Error(`withOrg: invalid orgId — expected UUID, received: "${orgId}"`)
  }
  return getDb().transaction(async (tx) => {
    // set_config(..., true) is the SET LOCAL equivalent: scoped to this transaction,
    // automatically cleared on commit/rollback so pooled connections never leak org context.
    await tx.execute(sql`SELECT set_config('app.current_org_id', ${orgId}, true)`)
    return fn(tx as unknown as Tx)
  })
}

export async function withOrgReadScope<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  // Wired identically to withOrg() for now; differentiated in a later story when
  // read-only access patterns are introduced.
  return withOrg(orgId, fn)
}

export async function withAdminAccess<T>(
  authCtx: { role?: string },
  fn: (tx: Tx) => Promise<T>
): Promise<T> {
  // TODO Story 1.11: full admin authorization validation lives here
  if (!authCtx || authCtx.role !== 'admin') {
    throw new Error('withAdminAccess: caller is not an admin')
  }
  return getDb().transaction((tx) => fn(tx as unknown as Tx))
}
