import { describe, it, expect, afterEach } from 'vitest'
import postgres from 'postgres'
import { checkRlsCoverage, RlsCoverageGapError } from '../check-rls-coverage.js'

const sql = postgres(
  process.env['DATABASE_URL'] ??
    'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'
)

// Database creation/drop requires the superuser — vault_app has no CREATEDB privilege.
const adminSql = postgres(
  process.env['ADMIN_DATABASE_URL'] ?? 'postgresql://postgres:password@localhost:5432/project_vault'
)

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
  })

  it('resolves when every org_id table has an RLS policy', async () => {
    await expect(checkRlsCoverage(sql)).resolves.toBeUndefined()
  })

  it('throws RlsCoverageGapError listing the table missing a policy', async () => {
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

  it('includes audit_log_entries in the gap list when its policy is missing', async () => {
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

  it('throws when no tables exist in the target database', async () => {
    const emptyDbName = `check_rls_empty_${Date.now()}`
    let emptySql: ReturnType<typeof postgres> | undefined
    try {
      await adminSql.unsafe(`CREATE DATABASE ${emptyDbName}`)
      emptySql = postgres(`postgresql://postgres:password@localhost:5432/${emptyDbName}`)
      await expect(checkRlsCoverage(emptySql)).rejects.toThrow(/No tables found/)
    } finally {
      await emptySql?.end()
      await adminSql.unsafe(`DROP DATABASE IF EXISTS ${emptyDbName}`)
    }
  })
})
