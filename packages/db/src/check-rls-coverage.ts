import type postgres from 'postgres'
import { RLS_FORCE_ALLOWLIST } from './rls-force-allowlist.js'

export { RLS_FORCE_ALLOWLIST } from './rls-force-allowlist.js'

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
  // Story 30.2 (DW-128): instance-level replay-burn ledger / pending-handoff state — no tenant is
  // known/trusted at ingestion time (handoff_pending_states.organization_id is untrusted claimed
  // input until the confirm route's org cross-check runs). Same reasoning as
  // sso_login_states/platform_security_events above.
  'handoff_token_jti',
  'handoff_pending_states',
  // user_onboarding: no RLS — access gated in application layer by auth.userId == userId; org_id is a FK for cascade, not for multi-tenant row filtering.
  'user_onboarding',
  // account_recovery_tokens: identity-scoped (AC-1) — the row has no org_id column (only an
  // initiator_org_id FK for audit context), and a recovery token authorizes a credential reset
  // for a user, not an org-scoped resource. Same reasoning as mfa_recovery_codes/revoked_tokens.
  'account_recovery_tokens',
  // Story 9.1 D3: platform-level (whole-instance, not per-org) backup/restore and admin-alert
  // tables — neither has an org_id column (backup/restore spans every org, D2), so they follow
  // the vault_state/api_instances precedent rather than orgScoped().
  'backup_runs',
  'admin_alerts',
  // Story 9.2 D3: platform-level singleton system_settings row — no org_id column (instance-wide
  // configuration, not per-org), same precedent as vault_state/admin_alerts.
  'system_settings',
  // Story 9.4 D4: platform_audit_events has no org_id column (it is platform-scoped, not
  // tenant-scoped) so it is invisible to this scan's org_id-column heuristic regardless — RLS is
  // still enabled on it (app.platform_operator_verified session-var policy), documented here for
  // consistency with every other platform-level table in this set. The two support tables
  // (maintenance-state, pending-entries) are also platform-level singletons/staging tables with
  // no org_id column.
  'platform_audit_events',
  'platform_audit_maintenance_state',
  'platform_audit_pending_entries',
  // Story 14.3 Task 2: sso_login_states has no org_id column — the caller is unauthenticated and
  // no org is known yet at state-mint time (before onAuthenticate() ever runs). Single-use,
  // 10-minute-TTL, hashed-value semantics (mirroring refresh_tokens/pending_mfa_sessions'
  // pre-auth trust model) replace RLS for this table.
  'sso_login_states',
])

const APPEND_ONLY_AUDIT_TABLES = new Set(['audit_log_entries', 'platform_audit_events'])

export class RlsCoverageDriftError extends Error {
  constructor(
    public readonly dimension: string,
    public readonly gaps: string[]
  ) {
    super(`${dimension} drift detected: ${gaps.join(', ')}`)
  }
}

export class RlsCoverageGapError extends Error {
  constructor(public readonly gaps: string[]) {
    super(`RLS coverage gap detected: ${gaps.join(', ')}`)
  }
}

// One database-boundary check intentionally keeps its dimensions in one ordered transaction-facing
// routine so a caller cannot accidentally run policy, ownership, ACL, and view checks against
// different snapshots. The individual dimensions are kept as straight-line catalog assertions.
// eslint-disable-next-line complexity, sonarjs/cognitive-complexity
export async function checkRlsCoverage(sql: postgres.Sql): Promise<void> {
  const publicTables = await sql<
    {
      table_name: string
      schema_name: string
      rls_enabled: boolean
      force_rls: boolean
      owner: string
      owner_superuser: boolean
      owner_bypassrls: boolean
    }[]
  >`
    SELECT c.relname AS table_name,
           n.nspname AS schema_name,
           c.relrowsecurity AS rls_enabled,
           c.relforcerowsecurity AS force_rls,
           r.rolname AS owner,
           r.rolsuper AS owner_superuser,
           r.rolbypassrls AS owner_bypassrls
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_catalog.pg_roles r ON r.oid = c.relowner
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p')
     ORDER BY c.relname
  `

  if (publicTables.length === 0) {
    throw new Error('No tables found — run db:migrate first')
  }

  const orgScopedTables = await sql<{ table_name: string }[]>`
    SELECT DISTINCT c.relname AS table_name
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p')
       AND a.attname = 'org_id'
       AND NOT a.attisdropped
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
  const policyGaps = orgScopedTables
    .map((row) => row.table_name)
    .filter((table) => !EXCLUDED_TABLES.has(table))
    .filter((table) => !policiedSet.has(table))

  if (policyGaps.length > 0) {
    throw new RlsCoverageGapError(policyGaps)
  }

  const rlsEnabledTables = publicTables.filter((table) => table.rls_enabled)
  const rlsEnabledSet = new Set(rlsEnabledTables.map((table) => table.table_name))

  const rlsGaps = orgScopedTables
    .map((row) => row.table_name)
    .filter((table) => !EXCLUDED_TABLES.has(table))
    .filter((table) => !rlsEnabledSet.has(table))
  if (rlsGaps.length > 0) {
    throw new RlsCoverageDriftError('RLS enabled coverage', rlsGaps)
  }

  // Compare the complete public-table catalog, not only the enabled side. This catches both
  // ENABLE without FORCE and the equally dangerous FORCE without ENABLE state.
  const forceGaps = publicTables
    .filter((table) => !RLS_FORCE_ALLOWLIST.has(table.table_name))
    .filter((table) => table.rls_enabled !== table.force_rls)
    .map((table) => `${table.table_name} (ENABLE=${table.rls_enabled}, FORCE=${table.force_rls})`)
  if (forceGaps.length > 0) {
    throw new RlsCoverageDriftError('ENABLE/FORCE set equality', forceGaps)
  }

  const ownerGaps = rlsEnabledTables
    .filter((table) => table.owner_superuser || table.owner_bypassrls)
    .map(
      (table) =>
        `${table.table_name} (owner=${table.owner}, superuser=${table.owner_superuser}, bypassrls=${table.owner_bypassrls})`
    )
  const vaultAppOwnedTables = publicTables
    .filter((table) => table.owner === 'vault_app')
    .map((table) => `${table.table_name} (owner=vault_app)`)
  if (ownerGaps.length > 0 || vaultAppOwnedTables.length > 0) {
    throw new RlsCoverageDriftError('RLS-exempt ownership', [...ownerGaps, ...vaultAppOwnedTables])
  }

  const ownerMemberships = await sql<{ member: string }[]>`
    SELECT member_role.rolname AS member
      FROM pg_catalog.pg_auth_members memberships
      JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = memberships.roleid
      JOIN pg_catalog.pg_roles member_role ON member_role.oid = memberships.member
     WHERE owner_role.rolname = 'vault_owner'
     ORDER BY member_role.rolname
  `
  if (ownerMemberships.length > 0) {
    throw new RlsCoverageDriftError(
      'vault_owner membership',
      ownerMemberships.map((row) => `${row.member} (member of vault_owner)`)
    )
  }

  const appPrivileges = await sql<{ table_name: string; privilege_type: string }[]>`
    SELECT c.relname AS table_name, acl.privilege_type
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) acl ON true
      JOIN pg_catalog.pg_roles grantee ON grantee.oid = acl.grantee
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p')
       AND c.relrowsecurity
       AND grantee.rolname = 'vault_app'
  `
  const privilegesByTable = new Map<string, Set<string>>()
  for (const row of appPrivileges) {
    const privileges = privilegesByTable.get(row.table_name) ?? new Set<string>()
    privileges.add(row.privilege_type)
    privilegesByTable.set(row.table_name, privileges)
  }
  const grantGaps: string[] = []
  for (const table of rlsEnabledTables) {
    const actual = privilegesByTable.get(table.table_name) ?? new Set<string>()
    const required = APPEND_ONLY_AUDIT_TABLES.has(table.table_name)
      ? ['SELECT', 'INSERT']
      : ['SELECT', 'INSERT', 'UPDATE', 'DELETE']
    const missing = required.filter((privilege) => !actual.has(privilege))
    const forbidden = APPEND_ONLY_AUDIT_TABLES.has(table.table_name)
      ? ['UPDATE', 'DELETE', 'TRUNCATE'].filter((privilege) => actual.has(privilege))
      : []
    if (missing.length > 0 || forbidden.length > 0) {
      const details = [
        missing.length > 0 ? `missing=${missing.join('|')}` : '',
        forbidden.length > 0 ? `forbidden=${forbidden.join('|')}` : '',
      ]
        .filter(Boolean)
        .join(', ')
      grantGaps.push(`${table.table_name} (role=vault_app; ${details})`)
    }
  }
  if (grantGaps.length > 0) {
    throw new RlsCoverageDriftError('vault_app table grants', grantGaps)
  }

  const outOfScopeOrgTables = await sql<{ schema_name: string; table_name: string }[]>`
    SELECT DISTINCT n.nspname AS schema_name, c.relname AS table_name
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
     WHERE c.relkind IN ('r', 'p')
       AND a.attname = 'org_id'
       AND NOT a.attisdropped
       AND n.nspname NOT IN ('public', 'drizzle', 'pgboss', 'information_schema')
       AND n.nspname NOT LIKE 'pg\_%' ESCAPE '\\'
  `
  if (outOfScopeOrgTables.length > 0) {
    throw new RlsCoverageDriftError(
      'non-public org_id table schema scope',
      outOfScopeOrgTables.map((row) => `${row.schema_name}.${row.table_name}`)
    )
  }

  // Views are intentionally checked separately from table coverage: PostgreSQL evaluates a normal
  // view over an RLS table as the view owner. AC19 rejects those unless security_invoker is set.
  const unsafeViews = await sql<
    {
      view_name: string
      relkind: string
      owner: string
      reloptions: string[] | null
      base_table: string
    }[]
  >`
    SELECT DISTINCT view_class.relname AS view_name,
           view_class.relkind,
           pg_get_userbyid(view_class.relowner) AS owner,
           view_class.reloptions,
           base_class.relname AS base_table
      FROM pg_catalog.pg_depend dep
      JOIN pg_catalog.pg_rewrite rewrite ON rewrite.oid = dep.objid
      JOIN pg_catalog.pg_class view_class ON view_class.oid = rewrite.ev_class
      JOIN pg_catalog.pg_class base_class ON base_class.oid = dep.refobjid
      JOIN pg_catalog.pg_namespace base_schema ON base_schema.oid = base_class.relnamespace
     WHERE view_class.relkind IN ('v', 'm')
       AND base_class.relkind IN ('r', 'p')
       AND base_class.relrowsecurity
       AND base_schema.nspname = 'public'
  `
  const unsafeViewGaps = unsafeViews
    .filter(
      (view) => view.relkind === 'm' || !(view.reloptions ?? []).includes('security_invoker=true')
    )
    .map(
      (view) =>
        `${view.view_name} (kind=${view.relkind}, owner=${view.owner}, base=${view.base_table})`
    )
  if (unsafeViewGaps.length > 0) {
    throw new RlsCoverageDriftError('RLS view safety', unsafeViewGaps)
  }
}
