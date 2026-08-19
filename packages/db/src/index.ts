import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'

export type Tx = Parameters<Parameters<ReturnType<typeof drizzle>['transaction']>[0]>[0]

/** Story 9.6 D1.3: a single reserved connection returned by `reserveConnection()` below — used
 * for session-scoped state (advisory locks) that must persist across multiple statements. */
export type ReservedConnection = Awaited<ReturnType<ReturnType<typeof postgres>['reserve']>>

// Story 9.6 D1.3: hoisted to module scope (was previously a `getDb()`-local closure variable) so
// `reserveConnection()` below can share the exact same underlying `postgres()` client/pool
// instead of creating a second, separate one.
let _pgClient: ReturnType<typeof postgres> | null = null
let _db: ReturnType<typeof drizzle> | null = null

function getPgClient(): ReturnType<typeof postgres> {
  if (!_pgClient) {
    _pgClient = postgres(
      process.env['DATABASE_URL'] ?? 'postgresql://postgres:password@localhost:5432/project_vault'
    )
  }
  return _pgClient
}

export function getDb(): ReturnType<typeof drizzle> {
  if (!_db) {
    _db = drizzle(getPgClient())
  }
  return _db
}

/**
 * Story 9.6 D1.3: returns a single reserved connection (postgres-js `sql.reserve()`) checked out
 * from the pool for exclusive use until explicitly released — required for session-scoped state
 * (advisory locks) that must persist across multiple statements. Never share a reserved
 * connection with pooled queries: acquiring a session-level lock on a connection borrowed from a
 * normal pooled query and then returning that connection to the pool without unlocking would leak
 * the lock onto whatever unrelated query the pool later hands that connection to.
 *
 * Caller MUST call `.release()` when done (in a `finally` block).
 */
export async function reserveConnection(): Promise<ReservedConnection> {
  return getPgClient().reserve()
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
    await tx.execute(
      sql`SELECT set_config('app.current_org_id', ${orgId}, true),
                 set_config('app.current_user_id', '', true)`
    )
    return fn(tx as unknown as Tx)
  })
}

export async function withOrgAndUser<T>(
  orgId: string,
  userId: string,
  fn: (tx: Tx) => Promise<T>
): Promise<T> {
  if (!UUID_REGEX.test(orgId)) {
    throw new Error(`withOrgAndUser: invalid orgId — expected UUID, received: "${orgId}"`)
  }
  if (!UUID_REGEX.test(userId)) {
    throw new Error(`withOrgAndUser: invalid userId — expected UUID, received: "${userId}"`)
  }
  return getDb().transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.current_org_id', ${orgId}, true),
                 set_config('app.current_user_id', ${userId}, true)`
    )
    return fn(tx as unknown as Tx)
  })
}

export async function withOrgReadScope<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  // Wired identically to withOrg() for now; differentiated in a later story when
  // read-only access patterns are introduced.
  return withOrg(orgId, fn)
}

/**
 * Story 9.4 D4: transaction-scoped equivalent of `withOrg()` for `platform_audit_events`'
 * RLS policy — sets `app.platform_operator_verified` via `set_config(..., true)` (SET LOCAL
 * semantics, same discipline as `app.current_org_id`) so the variable never leaks across a pooled
 * connection into an unrelated subsequent request (AC-3 edge case). Callers must have already
 * confirmed `requirePlatformOperator()` passed before calling this.
 */
export async function withPlatformOperatorContext<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.platform_operator_verified', 'true', true)`)
    return fn(tx as unknown as Tx)
  })
}

/**
 * Application-role authorization helper. This uses the RLS-bound `getDb()` transaction and is
 * unrelated to `getAdminDb()`, the separately configured non-superuser `BYPASSRLS` pool used by
 * narrowly reviewed cross-org/pre-auth call sites. Do not use this helper for cross-org reads.
 */
export async function withAdminAccess<T>(
  authCtx: { role?: string },
  fn: (tx: Tx) => Promise<T>
): Promise<T> {
  // Tracked forward-dependency on Story 1.11, not an unresolved open item.
  // NOSONAR(typescript:S1135) TODO Story 1.11: full admin authorization validation lives here.
  if (authCtx?.role !== 'admin') {
    throw new Error('withAdminAccess: caller is not an admin')
  }
  return getDb().transaction((tx) => fn(tx as unknown as Tx))
}

// Story 23.5: separate extension-role pool. This export does not share or alter the core pool
// above; the implementation lives in its own module so the boundary is reviewable.
export {
  EXTENSION_DB_DEFAULT_MAX,
  EXTENSION_DB_PLACEHOLDER_CREDENTIAL,
  createExtensionDbHandle,
  getExtensionDbHandle,
  getExtensionDbPoolMax,
  resetExtensionDbClientForTests,
  validateExtensionDatabaseUrl,
} from './extension-db.js'
export type { ExtensionDbHandle, ExtensionDbOperation } from './extension-db.js'
export {
  EXTENSION_DB_SCOPE_DENYLIST,
  buildGrantStatements,
  canonicalizeDbScope,
  hashExtensionDbScope,
  quoteIdentifier,
  validateDbScopeTable,
} from './extension-db-scope.js'
export type { ExtensionDbScopeEntry } from './extension-db-scope.js'
