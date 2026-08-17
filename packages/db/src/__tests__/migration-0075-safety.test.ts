import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const MIGRATION_PATH = resolve(
  import.meta.dirname,
  '../migrations/0075_audit_org_storage_quota.sql'
)

describe('migration 0075 safety', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf-8')

  it('creates exactly two new tables, additively', () => {
    expect(sql).toMatch(/CREATE TABLE "audit_storage_quota_config"/)
    expect(sql).toMatch(/CREATE TABLE "audit_org_storage_usage"/)
    expect(sql.match(/CREATE TABLE/g)).toHaveLength(2)
    expect(sql).not.toMatch(/DROP TABLE|DROP COLUMN|RENAME|TRUNCATE|DELETE FROM/i)
  })

  it('does not touch audit_log_entries (AC-20: no column added, no backfill scan)', () => {
    expect(sql).not.toMatch(/ALTER TABLE "audit_log_entries"/)
    expect(sql).not.toMatch(/UPDATE "?audit_log_entries"?/i)
  })

  it('ships no write_rate_per_minute column or rate-bucket table (Layer 1 removed)', () => {
    expect(sql).not.toMatch(/write_rate_per_minute/i)
    expect(sql).not.toMatch(/throttle/i)
  })

  it('audit_storage_quota_config.quota_bytes rejects non-positive values', () => {
    expect(sql).toMatch(
      /CONSTRAINT "audit_storage_quota_config_quota_bytes_positive" CHECK \("audit_storage_quota_config"\."quota_bytes" > 0\)/
    )
  })

  it('audit_org_storage_usage counters reject negative values', () => {
    expect(sql).toMatch(/audit_org_storage_usage_bytes_used_non_negative.*>= 0/)
    expect(sql).toMatch(/audit_org_storage_usage_preauth_bytes_used_non_negative.*>= 0/)
    expect(sql).toMatch(/audit_org_storage_usage_entry_count_non_negative.*>= 0/)
  })

  it('both tables FK-CASCADE to organizations(id)', () => {
    expect(sql).toMatch(
      /ALTER TABLE "audit_storage_quota_config" ADD CONSTRAINT .* FOREIGN KEY \("org_id"\) REFERENCES "public"\."organizations"\("id"\) ON DELETE cascade/
    )
    expect(sql).toMatch(
      /ALTER TABLE "audit_org_storage_usage" ADD CONSTRAINT .* FOREIGN KEY \("org_id"\) REFERENCES "public"\."organizations"\("id"\) ON DELETE cascade/
    )
  })

  it('both tables have RLS enabled and forced, owned by vault_owner (AC-3, matching Story 24.1 conventions)', () => {
    expect(sql).toMatch(/ALTER TABLE "audit_storage_quota_config" ENABLE ROW LEVEL SECURITY/)
    expect(sql).toMatch(/ALTER TABLE "audit_org_storage_usage" ENABLE ROW LEVEL SECURITY/)
    expect(sql).toMatch(/ALTER TABLE "audit_storage_quota_config" FORCE ROW LEVEL SECURITY/)
    expect(sql).toMatch(/ALTER TABLE "audit_org_storage_usage" FORCE ROW LEVEL SECURITY/)
    expect(sql).toMatch(/ALTER TABLE "audit_storage_quota_config" OWNER TO vault_owner/)
    expect(sql).toMatch(/ALTER TABLE "audit_org_storage_usage" OWNER TO vault_owner/)
  })

  it('both policies are FOR ALL with both USING and WITH CHECK on the same predicate (finding M3)', () => {
    const policyBlocks = sql.match(/CREATE POLICY[\s\S]*?;/g) ?? []
    expect(policyBlocks).toHaveLength(2)
    for (const block of policyBlocks) {
      expect(block).toMatch(/FOR ALL/)
      expect(block).toMatch(
        /USING \(org_id = NULLIF\(current_setting\('app\.current_org_id', true\), ''\)::uuid\)/
      )
      expect(block).toMatch(
        /WITH CHECK \(org_id = NULLIF\(current_setting\('app\.current_org_id', true\), ''\)::uuid\)/
      )
    }
  })

  it('grants vault_app full CRUD on both tables (not append-only tables)', () => {
    expect(sql).toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "audit_storage_quota_config" TO vault_app/
    )
    expect(sql).toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "audit_org_storage_usage" TO vault_app/
    )
  })

  it('sets fillfactor = 70 on the hot usage table only', () => {
    expect(sql).toMatch(/ALTER TABLE "audit_org_storage_usage" SET \(fillfactor = 70\)/)
    expect(sql).not.toMatch(/audit_storage_quota_config.*fillfactor/)
  })
})
