import type postgres from 'postgres'

// Platform-level or identity-scoped tables that intentionally need no org RLS policy.
export const EXCLUDED_TABLES = new Set([
  'api_instances',
  'vault_state',
  'refresh_tokens',
  'revoked_tokens',
  'auth_rate_limit_buckets',
  'mfa_enrollments',
  'mfa_recovery_codes',
  'totp_used_codes',
  'failed_auth_attempts',
  'pending_mfa_sessions',
  'platform_security_events',
  // user_onboarding: no RLS — access gated in application layer by auth.userId == userId; org_id is a FK for cascade, not for multi-tenant row filtering.
  'user_onboarding',
  // account_recovery_tokens: identity-scoped (AC-1) — the row has no org_id column (only an
  // initiator_org_id FK for audit context), and a recovery token authorizes a credential reset
  // for a user, not an org-scoped resource. Same reasoning as mfa_recovery_codes/revoked_tokens.
  'account_recovery_tokens',
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
