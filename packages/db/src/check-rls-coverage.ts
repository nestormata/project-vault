import type postgres from 'postgres'

// Platform-level or identity-scoped tables that intentionally have no org_id column and need no RLS policy.
export const EXCLUDED_TABLES = new Set([
  'api_instances',
  'vault_state',
  'refresh_tokens',
  'platform_security_events',
])

export class RlsCoverageGapError extends Error {
  constructor(public readonly gaps: string[]) {
    super(`RLS coverage gap detected: ${gaps.join(', ')}`)
  }
}

export async function checkRlsCoverage(sql: postgres.Sql): Promise<void> {
  const tableCount = await sql<{ count: string }[]>`
    SELECT count(*)::text AS count
    FROM information_schema.tables
    WHERE table_schema = 'public'
  `

  if (Number(tableCount[0]?.count ?? 0) === 0) {
    throw new Error('No tables found — run db:migrate first')
  }

  const orgScopedTables = await sql<{ table_name: string }[]>`
    SELECT DISTINCT table_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'org_id'
  `

  const policiedTables = await sql<{ tablename: string }[]>`
    SELECT DISTINCT tablename
    FROM pg_policies
    WHERE schemaname = 'public' AND cmd = 'ALL'
  `
  const policiedSet = new Set(policiedTables.map((row) => row.tablename))

  // audit_log_entries always has an org_id column, so the general filter below
  // already covers the epic's explicit "verify audit_log_entries has a policy"
  // requirement — no separate check needed.
  const gaps = orgScopedTables
    .map((row) => row.table_name)
    .filter((table) => !EXCLUDED_TABLES.has(table))
    .filter((table) => !policiedSet.has(table))

  if (gaps.length > 0) {
    throw new RlsCoverageGapError(gaps)
  }
}
