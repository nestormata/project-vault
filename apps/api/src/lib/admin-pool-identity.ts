import { sql, type SQL } from 'drizzle-orm'
import { findDbErrorCause, type DbErrorReason } from './db-error-cause.js'

export type AdminPoolIdentityRow = {
  current_user: string
  rolsuper: boolean
  rolbypassrls: boolean
}

export type AdminPoolIdentityResult =
  | { status: 'ok'; identity: AdminPoolIdentityRow }
  | { status: 'superuser'; identity?: AdminPoolIdentityRow }
  | { status: 'no-bypassrls'; identity?: AdminPoolIdentityRow }
  | { status: 'unreachable'; reason?: AdminPoolUnreachableReason }

/**
 * Story 66.4 AC-4: why the admin pool could not be inspected, derived ONLY from the driver error's
 * `code` (Postgres SQLSTATE or Node errno) through a closed map, never from its message (driver
 * messages can carry host names or DSNs). Postgres reports a missing role as 28P01 (no role
 * enumeration), so `role_row_missing` is only reachable when the identity SELECT returns no row.
 */
export type AdminPoolUnreachableReason =
  | 'auth_failed'
  | 'database_missing'
  | 'permission_denied'
  | 'connection_failed'
  | 'role_row_missing'
  | 'unknown'

const UNKNOWN_HINT =
  'run the Story 24.2 migration, provision its credential, and verify .env.example'

const UNREACHABLE_HINTS: ReadonlyMap<AdminPoolUnreachableReason, string> = new Map([
  [
    'auth_failed',
    'provision the role\'s credential (see docs/development.md "Provision the vault_admin credential")',
  ],
  ['database_missing', 'the database in ADMIN_DATABASE_URL does not exist'],
  [
    'permission_denied',
    "the role lacks CONNECT on that database (re-run migrations or the isolated fixture's GRANT)",
  ],
  ['connection_failed', 'the database host is unreachable or still starting'],
  ['role_row_missing', 'the role does not exist in pg_roles'],
  ['unknown', UNKNOWN_HINT],
])

// Story 43.28 AC-1: the cause walk lives in the shared classifier. The admin-pool reason type keeps
// its 66.4 values; the reasons the shared classifier added (schema_missing, tls_failed) map to
// `unknown` here, so this check's messages and hints are unchanged.
const ADMIN_POOL_REASON: ReadonlyMap<DbErrorReason, AdminPoolUnreachableReason> = new Map([
  ['auth_failed', 'auth_failed'],
  ['database_missing', 'database_missing'],
  ['permission_denied', 'permission_denied'],
  ['connection_failed', 'connection_failed'],
])

export function classifyAdminPoolError(err: unknown): AdminPoolUnreachableReason {
  const cause = findDbErrorCause(err)
  return (cause && ADMIN_POOL_REASON.get(cause.reason)) ?? 'unknown'
}

export type AdminPoolExecutor = (query: SQL) => Promise<unknown>

export const ADMIN_POOL_IDENTITY_QUERY = sql`
  SELECT current_user, r.rolsuper, r.rolbypassrls
  FROM pg_roles AS r
  WHERE r.rolname = current_user
`

export async function inspectAdminPoolIdentity(
  execute: AdminPoolExecutor
): Promise<AdminPoolIdentityResult> {
  try {
    const raw = await execute(ADMIN_POOL_IDENTITY_QUERY)
    const row = (raw as AdminPoolIdentityRow[])[0]
    if (!row) return { status: 'unreachable', reason: 'role_row_missing' }
    if (row.rolsuper) return { status: 'superuser', identity: row }
    if (!row.rolbypassrls) return { status: 'no-bypassrls', identity: row }
    return { status: 'ok', identity: row }
  } catch (err) {
    return { status: 'unreachable', reason: classifyAdminPoolError(err) }
  }
}

export function adminPoolIdentityFailure(
  result: Exclude<AdminPoolIdentityResult, { status: 'ok' }>
): Error {
  switch (result.status) {
    case 'superuser':
      return new Error(
        'API will not start: ADMIN_DATABASE_URL connects as a superuser; run the Story 24.2 migration and rotate the setting to vault_admin'
      )
    case 'no-bypassrls':
      return new Error(
        'API will not start: ADMIN_DATABASE_URL connects as a role without BYPASSRLS; run the Story 24.2 migration and grant the approved vault_admin role'
      )
    case 'unreachable': {
      const reason = result.reason ?? 'unknown'
      return new Error(
        `API will not start: ADMIN_DATABASE_URL could not reach the configured role (reason: ${reason}); ${UNREACHABLE_HINTS.get(reason) ?? UNKNOWN_HINT}`
      )
    }
  }
}

export async function inspectConfiguredAdminPool(): Promise<AdminPoolIdentityResult> {
  // Keep this module importable by the operator preflight without loading the full API env
  // schema; the configured-pool adapter is only needed by the API bootstrap path.
  const { getAdminDb } = await import('./db.js')
  return inspectAdminPoolIdentity((query) => getAdminDb().execute(query))
}
