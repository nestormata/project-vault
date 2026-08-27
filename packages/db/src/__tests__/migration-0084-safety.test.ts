import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const MIGRATION_PATH = resolve(
  import.meta.dirname,
  '../migrations/0084_extension_ephemeral_state.sql'
)

describe('migration 0084 safety', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf-8')

  it('creates exactly one new table, additively (AC-5)', () => {
    expect(sql).toMatch(/CREATE TABLE "extension_ephemeral_state"/)
    expect(sql.match(/CREATE TABLE/g)).toHaveLength(1)
    expect(sql).not.toMatch(/DROP TABLE|DROP COLUMN|RENAME|TRUNCATE|DELETE FROM/i)
  })

  it('does not ALTER any pre-existing table (AC-5 migration compatibility)', () => {
    expect(sql).not.toMatch(/ALTER TABLE "organizations"/)
    expect(sql).not.toMatch(/ALTER TABLE "projects"/)
    expect(sql).not.toMatch(/ALTER TABLE "audit_log_entries"/)
    expect(sql).not.toMatch(/ALTER TABLE "platform_audit_events"/)
  })

  it('has exactly the columns AC-5 specifies', () => {
    expect(sql).toMatch(/"id" uuid PRIMARY KEY DEFAULT gen_random_uuid\(\) NOT NULL/)
    expect(sql).toMatch(/"org_id" uuid NOT NULL/)
    expect(sql).toMatch(/"extension_namespace" text NOT NULL/)
    expect(sql).toMatch(/"key" text NOT NULL/)
    expect(sql).toMatch(/"value_ciphertext" "bytea" NOT NULL/)
    expect(sql).toMatch(/"encryption_key_version" integer NOT NULL/)
    expect(sql).toMatch(/"expires_at" timestamp with time zone NOT NULL/)
    expect(sql).toMatch(/"created_at" timestamp with time zone DEFAULT now\(\) NOT NULL/)
    expect(sql).toMatch(/"updated_at" timestamp with time zone DEFAULT now\(\) NOT NULL/)
  })

  it('FK-CASCADEs org_id to organizations(id)', () => {
    expect(sql).toMatch(
      /ALTER TABLE "extension_ephemeral_state" ADD CONSTRAINT .* FOREIGN KEY \("org_id"\) REFERENCES "public"\."organizations"\("id"\) ON DELETE cascade/
    )
  })

  it('has a unique constraint on (org_id, extension_namespace, key) — AC-4/AC-5 namespacing', () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "idx_extension_ephemeral_state_unique" ON "extension_ephemeral_state" USING btree \("org_id","extension_namespace","key"\)/
    )
  })

  it('has a composite index on (org_id, expires_at) — AC-11 live-count query support', () => {
    expect(sql).toMatch(
      /CREATE INDEX "idx_extension_ephemeral_state_org_expiry" ON "extension_ephemeral_state" USING btree \("org_id","expires_at"\)/
    )
  })

  it('has RLS enabled and forced, owned by vault_owner (AC-5, matching Story 24.1 conventions)', () => {
    expect(sql).toMatch(/ALTER TABLE "extension_ephemeral_state" ENABLE ROW LEVEL SECURITY/)
    expect(sql).toMatch(/ALTER TABLE "extension_ephemeral_state" FORCE ROW LEVEL SECURITY/)
    expect(sql).toMatch(/ALTER TABLE "extension_ephemeral_state" OWNER TO vault_owner/)
  })

  it('policy is FOR ALL with both USING and WITH CHECK on the same org_id predicate (mirrors 0075)', () => {
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

  it('grants vault_app full CRUD (not append-only)', () => {
    expect(sql).toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "extension_ephemeral_state" TO vault_app/
    )
  })
})
