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

describe('checkRlsCoverage', () => {
  afterEach(async () => {
    // Restore policies in case a test dropped them without restoring.
    // DROP/CREATE POLICY require table ownership — vault_app isn't the owner.
    await adminSql`
      DO $$ BEGIN
        CREATE POLICY sessions_isolation ON sessions
          USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `
    await adminSql`
      DO $$ BEGIN
        CREATE POLICY audit_log_isolation ON audit_log_entries
          USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `
    // Story 8.2 AC-24: restore the three new tables' policies the same way.
    await adminSql`
      DO $$ BEGIN
        CREATE POLICY audit_exports_isolation ON audit_exports
          USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `
    await adminSql`
      DO $$ BEGIN
        CREATE POLICY audit_forwarding_config_isolation ON audit_forwarding_config
          USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `
    await adminSql`
      DO $$ BEGIN
        CREATE POLICY audit_retention_config_isolation ON audit_retention_config
          USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `
  })

  it('resolves when every org_id table has an RLS policy', async () => {
    await expect(checkRlsCoverage(sql)).resolves.toBeUndefined()
  })

  it('throws RlsCoverageGapError listing the table missing a policy', async () => {
    await withRlsPolicyMutationLock(async () => {
      await adminSql`DROP POLICY sessions_isolation ON sessions`

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
    await withRlsPolicyMutationLock(async () => {
      await adminSql`DROP POLICY audit_log_isolation ON audit_log_entries`

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
      await withRlsPolicyMutationLock(async () => {
        await adminSql.unsafe(`DROP POLICY ${table}_isolation ON ${table}`)

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
