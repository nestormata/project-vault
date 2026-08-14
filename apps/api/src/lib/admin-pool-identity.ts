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
  | { status: 'unreachable' }

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
    if (!row) return { status: 'unreachable' }
    if (row.rolsuper) return { status: 'superuser', identity: row }
    if (!row.rolbypassrls) return { status: 'no-bypassrls', identity: row }
    return { status: 'ok', identity: row }
  } catch {
    return { status: 'unreachable' }
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
    case 'unreachable':
      return new Error(
        'API will not start: ADMIN_DATABASE_URL could not reach the configured role; run the Story 24.2 migration, provision its credential, and verify .env.example'
      )
  }
}

export async function inspectConfiguredAdminPool(): Promise<AdminPoolIdentityResult> {
  // Keep this module importable by the operator preflight without loading the full API env
  // schema; the configured-pool adapter is only needed by the API bootstrap path.
  const { getAdminDb } = await import('./db.js')
  return inspectAdminPoolIdentity((query) => getAdminDb().execute(query))
}
