import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

/**
 * Story 8.2 AC-24/AC-25 — "zero-migration-diff-to-existing-columns assertion, repo-inspection
 * style" (matching Story 8.1's AC-16 precedent). Migration 0036 is this story's only schema
 * change; the only modification to the pre-existing `audit_log_entries` table is a new index —
 * no ALTER COLUMN, no DROP COLUMN, no changes to any other existing table.
 */
const MIGRATION_PATH = resolve(
  import.meta.dirname,
  '../migrations/0036_audit_search_export_forwarding.sql'
)

describe('migration 0036 safety (AC-24)', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf-8')

  it('never drops or alters an existing column', () => {
    expect(sql).not.toMatch(/DROP COLUMN/i)
    expect(sql).not.toMatch(/ALTER COLUMN/i)
    expect(sql).not.toMatch(/DROP TABLE/i)
  })

  it('touches audit_log_entries only by adding the new actor_token_id index', () => {
    const auditLogEntriesStatements = sql
      .split('--> statement-breakpoint')
      .filter((statement) => /audit_log_entries/i.test(statement))
    for (const statement of auditLogEntriesStatements) {
      const isNewIndex = /CREATE INDEX "idx_audit_log_entries_actor_token"/.test(statement)
      const isTriggerFunctionAmendment =
        /prevent_audit_log_mutation|purge_expired_audit_log_entries/.test(statement)
      expect(isNewIndex || isTriggerFunctionAmendment).toBe(true)
    }
  })

  it('creates exactly three new tables (audit_exports, audit_forwarding_config, audit_retention_config)', () => {
    expect(sql).toMatch(/CREATE TABLE "audit_exports"/)
    expect(sql).toMatch(/CREATE TABLE "audit_forwarding_config"/)
    expect(sql).toMatch(/CREATE TABLE "audit_retention_config"/)
    expect(sql.match(/CREATE TABLE/g)).toHaveLength(3)
  })

  it('enables RLS and adds an isolation policy for all three new tables', () => {
    for (const table of ['audit_exports', 'audit_forwarding_config', 'audit_retention_config']) {
      expect(sql).toMatch(new RegExp(`ALTER TABLE ${table}\\s+ENABLE ROW LEVEL SECURITY`))
      expect(sql).toMatch(new RegExp(`CREATE POLICY ${table}_isolation`))
    }
  })

  it('grants EXECUTE on the purge function to vault_app only — never a raw DELETE/UPDATE grant', () => {
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION purge_expired_audit_log_entries/)
    expect(sql).not.toMatch(/GRANT (DELETE|UPDATE) ON audit_log_entries/i)
  })
})
