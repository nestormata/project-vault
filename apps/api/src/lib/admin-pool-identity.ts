import { sql, type SQL } from 'drizzle-orm'

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

const REASON_BY_CODE: ReadonlyMap<string, AdminPoolUnreachableReason> = new Map([
  ['28P01', 'auth_failed'],
  ['28000', 'auth_failed'],
  ['3D000', 'database_missing'],
  ['42501', 'permission_denied'],
  ['ECONNREFUSED', 'connection_failed'],
  ['ENOTFOUND', 'connection_failed'],
  ['EAI_AGAIN', 'connection_failed'],
  ['ETIMEDOUT', 'connection_failed'],
  ['CONNECT_TIMEOUT', 'connection_failed'],
  ['57P03', 'connection_failed'],
])

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

// drizzle-orm 0.45 wraps driver errors in a DrizzleQueryError whose own message carries the query
// text and parameters; the SQLSTATE lives on its `cause`. Follow a short, bounded cause chain.
const MAX_CAUSE_DEPTH = 3

function ownProperty(value: unknown, key: 'code' | 'cause'): unknown {
  if (typeof value !== 'object' || value === null || !Object.hasOwn(value, key)) return undefined
  return Object.getOwnPropertyDescriptor(value, key)?.value
}

export function classifyAdminPoolError(err: unknown): AdminPoolUnreachableReason {
  let current = err
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH && current !== undefined; depth += 1) {
    const code = ownProperty(current, 'code')
    if (typeof code === 'string') return REASON_BY_CODE.get(code) ?? 'unknown'
    current = ownProperty(current, 'cause')
  }
  return 'unknown'
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
