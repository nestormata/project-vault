import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const MIGRATION_PATH = resolve(
  import.meta.dirname,
  '../migrations/0102_extension_audit_idempotency_keys.sql'
)

// Story 71.1 AC-4 — the idempotency-key dedupe table is one additive CREATE TABLE. It never
// touches audit_log_entries (AC-5): no ALTER, no trigger, no column change on any existing table.
describe('migration 0102 safety', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf-8')

  it('creates exactly one new table, additively', () => {
    expect(sql).toMatch(/CREATE TABLE "extension_audit_idempotency_keys"/)
    expect(sql.match(/CREATE TABLE/g)).toHaveLength(1)
    expect(sql).not.toMatch(/DROP |RENAME|TRUNCATE TABLE|DELETE FROM|CREATE TRIGGER/i)
  })

  it('does not ALTER any pre-existing table (audit_log_entries is untouched)', () => {
    const alteredTables = [...sql.matchAll(/ALTER TABLE "([a-z_]+)"/g)].map((m) => m[1])
    expect(new Set(alteredTables)).toEqual(new Set(['extension_audit_idempotency_keys']))
  })

  it('has exactly the specified columns and no payload column (fingerprint only)', () => {
    expect(sql).toMatch(/"org_id" uuid NOT NULL/)
    expect(sql).toMatch(/"extension_name" text NOT NULL/)
    expect(sql).toMatch(/"idempotency_key" text NOT NULL/)
    expect(sql).toMatch(/"content_fingerprint" text NOT NULL/)
    expect(sql).toMatch(/"audit_entry_id" uuid NOT NULL/)
    expect(sql).toMatch(/"created_at" timestamp with time zone DEFAULT now\(\) NOT NULL/)
    expect(sql).not.toMatch(/"payload"/)
  })

  it('has the composite primary key (org_id, extension_name, idempotency_key)', () => {
    expect(sql).toMatch(/PRIMARY KEY\("org_id","extension_name","idempotency_key"\)/)
  })

  it('FKs org_id to organizations and audit_entry_id to audit_log_entries (cascade follows the audit row)', () => {
    expect(sql).toMatch(
      /FOREIGN KEY \("org_id"\) REFERENCES "public"\."organizations"\("id"\) ON DELETE no action/
    )
    expect(sql).toMatch(
      /FOREIGN KEY \("audit_entry_id"\) REFERENCES "public"\."audit_log_entries"\("id"\) ON DELETE cascade/
    )
  })

  it('has RLS enabled and forced, owned by vault_owner', () => {
    expect(sql).toMatch(/ALTER TABLE "extension_audit_idempotency_keys" ENABLE ROW LEVEL SECURITY/)
    expect(sql).toMatch(/ALTER TABLE "extension_audit_idempotency_keys" FORCE ROW LEVEL SECURITY/)
    expect(sql).toMatch(/ALTER TABLE "extension_audit_idempotency_keys" OWNER TO vault_owner/)
  })

  it('policy is FOR ALL with USING and WITH CHECK on the org predicate', () => {
    const policyBlocks = sql.match(/CREATE POLICY[\s\S]*?;/g) ?? []
    expect(policyBlocks).toHaveLength(1)
    const [block] = policyBlocks
    expect(block).toMatch(/FOR ALL/)
    expect(block).toMatch(
      /USING \(org_id = NULLIF\(current_setting\('app\.current_org_id', true\), ''\)::uuid\)/
    )
    expect(block).toMatch(
      /WITH CHECK \(org_id = NULLIF\(current_setting\('app\.current_org_id', true\), ''\)::uuid\)/
    )
  })

  it('grants vault_app SELECT and INSERT only (append-only)', () => {
    expect(sql).toMatch(
      /GRANT SELECT, INSERT ON TABLE "extension_audit_idempotency_keys" TO vault_app;/
    )
    expect(sql).not.toMatch(/GRANT[^;]*(UPDATE|DELETE|TRUNCATE)/i)
    expect(sql).toMatch(
      /REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "extension_audit_idempotency_keys" FROM vault_app;/
    )
  })
})
