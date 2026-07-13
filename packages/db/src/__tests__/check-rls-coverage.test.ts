import { describe, it, expect, afterEach } from 'vitest'
import postgres from 'postgres'
import { checkRlsCoverage, RlsCoverageGapError } from '../check-rls-coverage.js'

const sql = postgres(
  process.env['DATABASE_URL'] ??
    'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'
)

// Database creation/drop requires the superuser — vault_app has no CREATEDB privilege.
const adminConnectionString =
  process.env['ADMIN_DATABASE_URL'] ?? 'postgresql://postgres:password@localhost:5432/project_vault'
const adminSql = postgres(adminConnectionString)

// Serialize live-policy mutation against the shared dev/CI Postgres instance. API integration
// tests authenticate via the sessions table RLS policy; dropping it concurrently yields flaky 401s.
const RLS_POLICY_MUTATION_LOCK = 758_304_221

async function withRlsPolicyMutationLock<T>(fn: () => Promise<T>): Promise<T> {
  await adminSql`SELECT pg_advisory_lock(${RLS_POLICY_MUTATION_LOCK})`
  try {
    return await fn()
  } finally {
    await adminSql`SELECT pg_advisory_unlock(${RLS_POLICY_MUTATION_LOCK})`
  }
}

// Story 1.15: policy definitions used both by the helper below and by afterEach's
// last-resort restore. Keeping one source of truth avoids the two drifting apart.
const POLICY_DEFS: Record<string, string> = {
  sessions_isolation: `CREATE POLICY sessions_isolation ON sessions
    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)`,
  audit_log_isolation: `CREATE POLICY audit_log_isolation ON audit_log_entries
    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)`,
  audit_exports_isolation: `CREATE POLICY audit_exports_isolation ON audit_exports
    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)`,
  audit_forwarding_config_isolation: `CREATE POLICY audit_forwarding_config_isolation ON audit_forwarding_config
    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)`,
  audit_retention_config_isolation: `CREATE POLICY audit_retention_config_isolation ON audit_retention_config
    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)`,
}

async function restorePolicy(policyName: string): Promise<void> {
  // policyName is always one of this test file's own hardcoded literals, never external input.
  // eslint-disable-next-line security/detect-object-injection -- see comment above
  const createStmt = POLICY_DEFS[policyName]
  if (!createStmt) throw new Error(`restorePolicy: no definition registered for ${policyName}`)
  await adminSql.unsafe(`
    DO $$ BEGIN
      ${createStmt};
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$
  `)
}

/**
 * Story 1.15 root-cause fix: the previous version of this file dropped a live RLS policy
 * directly in each test body and relied *solely* on a file-level `afterEach` hook to restore
 * it afterwards. That left a real window — between the DROP landing and the `afterEach`
 * firing — during which any OTHER suite querying the same shared Postgres instance (this
 * file's own top comment already documents apps/api integration tests seeing flaky 401s from
 * exactly this) would see the table's RLS fail *closed* (Postgres denies all non-owner access
 * to a table with RLS enabled and zero policies) rather than leak — but that's still enough to
 * produce a spurious "expected 1 row, got 0" failure in an unrelated suite (e.g.
 * rls-isolation.test.ts's `sessions`/`audit_log_entries` assertions), which is a plausible
 * explanation for this story's reported "off-by-one" `packages/db` flake. Restoring the policy
 * *inline*, in a `finally` immediately wrapping the drop (not deferred to `afterEach`), closes
 * that window to the smallest span physically possible (the body of `fn` itself) instead of
 * "until this test file's current test finishes". `afterEach` is kept as a last-resort net for
 * the one case this can't cover — the process being killed outright before `finally` runs.
 */
async function withPolicyDropped<T>(
  table: string,
  policyName: string,
  fn: () => Promise<T>
): Promise<T> {
  return withRlsPolicyMutationLock(async () => {
    await adminSql.unsafe(`DROP POLICY ${policyName} ON ${table}`)
    try {
      return await fn()
    } finally {
      await restorePolicy(policyName)
    }
  })
}

describe('checkRlsCoverage', () => {
  afterEach(async () => {
    // Story 1.15: last-resort safety net only. The primary restore is now inline (see
    // `withPolicyDropped` above) and runs regardless of whether the test passed, failed, or
    // threw — this hook only still matters if the process were killed before that `finally`
    // ran (e.g. OOM/SIGKILL mid-test), which inline `finally` blocks cannot protect against.
    // DROP/CREATE POLICY require table ownership — vault_app isn't the owner.
    for (const policyName of Object.keys(POLICY_DEFS)) {
      await restorePolicy(policyName)
    }
  })

  it('resolves when every org_id table has an RLS policy', async () => {
    await expect(checkRlsCoverage(sql)).resolves.toBeUndefined()
  })

  it('throws RlsCoverageGapError listing the table missing a policy', async () => {
    await withPolicyDropped('sessions', 'sessions_isolation', async () => {
      let caught: unknown
      try {
        await checkRlsCoverage(sql)
      } catch (error) {
        caught = error
      }

      expect(caught).toBeInstanceOf(RlsCoverageGapError)
      expect((caught as RlsCoverageGapError).gaps).toContain('sessions')
    })
  })

  it('includes audit_log_entries in the gap list when its policy is missing', async () => {
    await withPolicyDropped('audit_log_entries', 'audit_log_isolation', async () => {
      let caught: unknown
      try {
        await checkRlsCoverage(sql)
      } catch (error) {
        caught = error
      }

      expect(caught).toBeInstanceOf(RlsCoverageGapError)
      expect((caught as RlsCoverageGapError).gaps).toContain('audit_log_entries')
    })
  })

  // Story 8.2 AC-24: named regression tests for the three new tables, following Story 8.1's
  // AC-9 precedent of never relying on the generic mechanism alone.
  for (const table of ['audit_exports', 'audit_forwarding_config', 'audit_retention_config']) {
    it(`includes ${table} in the gap list when its policy is missing`, async () => {
      await withPolicyDropped(table, `${table}_isolation`, async () => {
        let caught: unknown
        try {
          await checkRlsCoverage(sql)
        } catch (error) {
          caught = error
        }

        expect(caught).toBeInstanceOf(RlsCoverageGapError)
        expect((caught as RlsCoverageGapError).gaps).toContain(table)
      })
    })
  }

  // Story 1.15 AC-3 regression test: proves the policy is restored *before* this test's own
  // body returns — i.e. without relying on the file-level `afterEach` — closing the
  // cross-suite race window documented on `withPolicyDropped` above. Against the pre-fix code
  // (bare DROP + afterEach-only restore) this is RED: querying pg_policies immediately after
  // the block still shows the policy missing, because nothing had restored it yet at that
  // point in program order. Against the fixed code it's GREEN, because the restore is the
  // `finally` that runs before `withPolicyDropped` returns control here.
  it('restores the dropped policy inline, before afterEach ever runs', async () => {
    await withPolicyDropped('sessions', 'sessions_isolation', async () => {
      // Intentionally empty: we only care about the state immediately after this block exits.
    })

    const rows = await adminSql<{ policyname: string }[]>`
      SELECT policyname FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'sessions' AND policyname = 'sessions_isolation'
    `
    expect(rows).toHaveLength(1)
  })

  it('throws when no tables exist in the target database', async () => {
    const emptyDbName = `check_rls_empty_${Date.now()}`
    let emptySql: ReturnType<typeof postgres> | undefined
    try {
      await adminSql.unsafe(`CREATE DATABASE ${emptyDbName}`)
      // Reuse the admin connection's host/port/credentials rather than hardcoding
      // localhost:5432 — CI/dev may point ADMIN_DATABASE_URL at a non-default port.
      emptySql = postgres(adminConnectionString.replace(/\/[^/]*$/, `/${emptyDbName}`))
      await expect(checkRlsCoverage(emptySql)).rejects.toThrow(/No tables found/)
    } finally {
      await emptySql?.end()
      await adminSql.unsafe(`DROP DATABASE IF EXISTS ${emptyDbName}`)
    }
  })
})
