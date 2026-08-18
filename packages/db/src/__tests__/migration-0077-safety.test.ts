import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const MIGRATION_PATH = resolve(
  import.meta.dirname,
  '../migrations/0077_audit_org_write_rate_limit.sql'
)

describe('migration 0077 safety', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf-8')

  it('adds columns only, additively — no new table, no destructive statement', () => {
    expect(sql).not.toMatch(/CREATE TABLE/)
    expect(sql).not.toMatch(/DROP TABLE|DROP COLUMN|RENAME|TRUNCATE|DELETE FROM/i)
    expect(sql.match(/ALTER TABLE "audit_org_storage_usage" ADD COLUMN/g)).toHaveLength(6)
    expect(sql.match(/ALTER TABLE "audit_storage_quota_config" ADD COLUMN/g)).toHaveLength(1)
  })

  it('does not touch audit_log_entries', () => {
    expect(sql).not.toMatch(/ALTER TABLE "audit_log_entries"/)
    expect(sql).not.toMatch(/UPDATE "?audit_log_entries"?/i)
  })

  it('adds no new table and no new RLS policy (AC-2: existing row-level policies already cover new columns)', () => {
    expect(sql).not.toMatch(/CREATE POLICY/)
    expect(sql).not.toMatch(/ENABLE ROW LEVEL SECURITY/)
    expect(sql).not.toMatch(/FORCE ROW LEVEL SECURITY/)
  })

  it('audit_org_storage_usage gains the six documented columns with correct types/defaults', () => {
    expect(sql).toMatch(
      /ALTER TABLE "audit_org_storage_usage" ADD COLUMN "rate_window_count" bigint DEFAULT 0 NOT NULL/
    )
    expect(sql).toMatch(
      /ALTER TABLE "audit_org_storage_usage" ADD COLUMN "rate_window_reset_at" timestamp with time zone;/
    )
    expect(sql).toMatch(
      /ALTER TABLE "audit_org_storage_usage" ADD COLUMN "preauth_rate_window_count" bigint DEFAULT 0 NOT NULL/
    )
    expect(sql).toMatch(
      /ALTER TABLE "audit_org_storage_usage" ADD COLUMN "preauth_rate_window_reset_at" timestamp with time zone;/
    )
    expect(sql).toMatch(
      /ALTER TABLE "audit_org_storage_usage" ADD COLUMN "rate_refused_count" bigint DEFAULT 0 NOT NULL/
    )
    expect(sql).toMatch(
      /ALTER TABLE "audit_org_storage_usage" ADD COLUMN "last_rate_refusal_at" timestamp with time zone;/
    )
  })

  it('audit_storage_quota_config gains write_rate_per_minute, nullable, no default', () => {
    expect(sql).toMatch(
      /ALTER TABLE "audit_storage_quota_config" ADD COLUMN "write_rate_per_minute" bigint;/
    )
  })

  it('write_rate_per_minute rejects non-positive values (NULL = no override, mirrors quota_bytes)', () => {
    expect(sql).toMatch(
      /CONSTRAINT "audit_storage_quota_config_write_rate_per_minute_positive" CHECK \("audit_storage_quota_config"\."write_rate_per_minute" > 0\)/
    )
  })

  it('rate window counters reject negative values', () => {
    expect(sql).toMatch(/audit_org_storage_usage_rate_window_count_non_negative.*>= 0/)
    expect(sql).toMatch(/audit_org_storage_usage_preauth_rate_window_count_non_negative.*>= 0/)
  })
})
