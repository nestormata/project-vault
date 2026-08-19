import postgres from 'postgres'
import {
  EXTENSION_DB_SCOPE_DENYLIST,
  buildGrantStatements,
  canonicalizeDbScope,
  hashExtensionDbScope,
  quoteIdentifier,
  type ExtensionDbScopeEntry,
} from '../extension-db-scope.js'

export { hashExtensionDbScope }

export type ExtensionScopeApproval = {
  extension_name: string
  manifest_scope_hash: string
  approved_scope: ExtensionDbScopeEntry[]
  tool_owned_grants: string[]
}

export function manifestScopeHash(scope: ExtensionDbScopeEntry[] | undefined): string {
  return hashExtensionDbScope(scope ?? [])
}

export type GrantPlan = { grants: string[]; revokes: string[]; foreign: string[] }

function assertDeclaredScopeAllowed(scope: ExtensionDbScopeEntry[]): void {
  if (scope.some((entry) => EXTENSION_DB_SCOPE_DENYLIST.has(entry.table))) {
    throw new Error('Extension DB scope contains a denied audit or pgboss object')
  }
}

function selectRevokes(plan: GrantPlan, revokeForeign: boolean, revokeAll: boolean): string[] {
  return revokeForeign || revokeAll ? [...plan.revokes, ...plan.foreign] : plan.revokes
}

function printPlan(grants: string[], revokes: string[]): void {
  for (const statement of [...grants, ...revokes]) process.stdout.write(`${statement};\n`)
}

async function applyPlan(
  sql: postgres.Sql,
  extensionName: string,
  desired: Set<string>,
  grants: string[],
  revokes: string[]
): Promise<void> {
  await sql.begin(async (tx) => {
    for (const statement of grants) await tx.unsafe(statement)
    for (const statement of revokes) {
      await tx.unsafe(statement.replace(/^GRANT /, 'REVOKE ').replace(/ TO /, ' FROM '))
    }
    await tx`
      UPDATE extension_db_scope_approvals
         SET tool_owned_grants = ${JSON.stringify([...desired])}::jsonb
       WHERE extension_name = ${extensionName}
    `
  })
}

async function assertGrantConnection(sql: postgres.Sql): Promise<void> {
  const [identity] = await sql<
    { current_user: string; database_name: string; can_connect: boolean }[]
  >`
    SELECT current_user, current_database() AS database_name,
           has_database_privilege(current_user, current_database(), 'CONNECT') AS can_connect
  `
  if (!identity?.can_connect || ['vault_extension', 'vault_app'].includes(identity.current_user)) {
    throw new Error(
      'EXTENSION_GRANT_DATABASE_URL connection cannot grant privileges or is a grantee role'
    )
  }
  const rollbackOnly = Symbol('extension-grant-preflight')
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe('CREATE TEMP TABLE extension_grant_preflight (id integer)')
      await tx.unsafe('GRANT SELECT ON TABLE extension_grant_preflight TO "vault_extension"')
      await tx.unsafe('REVOKE SELECT ON TABLE extension_grant_preflight FROM "vault_extension"')
      throw rollbackOnly
    })
  } catch (error) {
    if (error !== rollbackOnly) {
      throw new Error(
        'EXTENSION_GRANT_DATABASE_URL connection cannot issue privilege DDL; no grants were applied'
      )
    }
  }
  process.stdout.write(
    `extension grant identity: ${identity.current_user}@${identity.database_name}\n`
  )
}

async function assertScopeCatalog(
  sql: postgres.Sql,
  scope: ExtensionDbScopeEntry[]
): Promise<void> {
  for (const entry of canonicalizeDbScope(scope)) {
    const [row] = await sql<
      { exists: boolean; rls_enabled: boolean; org_policy: boolean; owner_safe: boolean }[]
    >`
      SELECT EXISTS (
               SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = 'public' AND c.relname = ${entry.table} AND c.relkind IN ('r', 'p')
             ) AS exists,
             COALESCE((SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                       WHERE n.nspname = 'public' AND c.relname = ${entry.table}), false) AS rls_enabled,
             EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = ${entry.table}
                     AND p.qual ILIKE '%app.current_org_id%') AS org_policy,
             NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                        JOIN pg_roles r ON r.oid = c.relowner
                        WHERE n.nspname = 'public' AND c.relname = ${entry.table}
                          AND (r.rolname = 'vault_extension'
                               OR pg_has_role('vault_extension', r.oid, 'USAGE'))) AS owner_safe
    `
    if (!row?.exists) throw new Error(`Approved extension table does not exist: ${entry.table}`)
    if (!row.rls_enabled || !row.org_policy) {
      throw new Error(`Extension table is not RLS/org-policy protected: ${entry.table}`)
    }
    if (!row.owner_safe)
      throw new Error(`Extension table ownership invariant failed: ${entry.table}`)
  }
}

async function readApproval(
  sql: postgres.Sql,
  extensionName: string
): Promise<ExtensionScopeApproval | undefined> {
  const [row] = await sql<ExtensionScopeApproval[]>`
    SELECT extension_name, manifest_scope_hash, approved_scope, tool_owned_grants
      FROM extension_db_scope_approvals WHERE extension_name = ${extensionName}
  `
  return row
}

async function buildPlan(sql: postgres.Sql, approval: ExtensionScopeApproval): Promise<GrantPlan> {
  await assertScopeCatalog(sql, approval.approved_scope)
  const desired = new Set(buildGrantStatements('vault_extension', approval.approved_scope))
  const [currentRows] = await Promise.all([
    sql<{ table_name: string; privilege_type: string }[]>`
      SELECT table_name, privilege_type
        FROM information_schema.role_table_grants
       WHERE grantee = 'vault_extension' AND table_schema = 'public'
    `,
  ])
  const current = new Set(
    currentRows.map(
      (row) =>
        `GRANT ${row.privilege_type} ON TABLE ${quoteIdentifier('public')}.${quoteIdentifier(row.table_name)} TO ${quoteIdentifier('vault_extension')}`
    )
  )
  const owned = new Set(approval.tool_owned_grants)
  const foreign = [...current].filter((statement) => !owned.has(statement))
  return {
    grants: [...desired].filter((statement) => !current.has(statement)),
    revokes: [...current].filter((statement) => owned.has(statement) && !desired.has(statement)),
    foreign,
  }
}

export async function reconcileExtensionGrants(options: {
  sql: postgres.Sql
  extensionName: string
  declaredScope: ExtensionDbScopeEntry[] | undefined
  apply?: boolean
  revokeForeign?: boolean
  revokeAll?: boolean
}): Promise<GrantPlan> {
  const {
    sql,
    extensionName,
    declaredScope = [],
    apply = false,
    revokeForeign = false,
    revokeAll = false,
  } = options
  await assertGrantConnection(sql)
  assertDeclaredScopeAllowed(declaredScope)
  const approval = await readApproval(sql, extensionName)
  if (!approval) throw new Error(`No operator approval exists for extension ${extensionName}`)
  if (approval.manifest_scope_hash !== manifestScopeHash(declaredScope)) {
    throw new Error(`Extension DB scope drift for ${extensionName}; re-approval is required`)
  }
  const plan = await buildPlan(sql, approval)
  const revokes = selectRevokes(plan, revokeForeign, revokeAll)
  printPlan(plan.grants, revokes)
  if (!apply) return { ...plan, revokes }
  await applyPlan(
    sql,
    extensionName,
    new Set(buildGrantStatements('vault_extension', approval.approved_scope)),
    plan.grants,
    revokes
  )
  return { ...plan, revokes }
}

async function main(): Promise<void> {
  const url = process.env['EXTENSION_GRANT_DATABASE_URL']
  if (!url) throw new Error('EXTENSION_GRANT_DATABASE_URL is required; no fallback is permitted')
  const packageName = process.env['VAULT_EXTENSIONS_PACKAGE']
  if (!packageName) {
    process.stdout.write('No extension configured; no grants to reconcile.\n')
    return
  }
  const extension = (await import(packageName)) as {
    default: { manifest: { name: string; dbScope?: ExtensionDbScopeEntry[] } }
  }
  const sql = postgres(url, { max: 1 })
  try {
    await reconcileExtensionGrants({
      sql,
      extensionName: extension.default.manifest.name,
      declaredScope: extension.default.manifest.dbScope,
      apply: process.argv.includes('--apply'),
      revokeForeign: process.argv.includes('--revoke-foreign'),
      revokeAll: process.argv.includes('--revoke-all'),
    })
  } finally {
    await sql.end()
  }
}

if (process.argv[1]?.endsWith('extension-grants.ts'))
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
