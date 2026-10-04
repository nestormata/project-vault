import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const MIGRATION_PATH = resolve(
  import.meta.dirname,
  '../migrations/0103_delegation_assertion_jti.sql'
)

// Story 71.7 AC-1/AC-2 — the delegation assertion burn ledger is one additive CREATE TABLE with
// FORCE RLS, an append-only vault_app grant and a least-privilege vault_admin prune grant. It
// never touches handoff_token_jti or any other pre-existing table.
describe('migration 0103 safety', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf-8')
  // Statement text only: the header comment names neighbouring tables and roles on purpose.
  const statements = sql.replaceAll(/^\s*--(?! statement-breakpoint).*$/gm, '')

  it('creates exactly one new table, additively', () => {
    expect(sql).toMatch(/CREATE TABLE "delegation_assertion_jti"/)
    expect(sql.match(/CREATE TABLE/g)).toHaveLength(1)
    expect(sql).not.toMatch(/DROP |RENAME|TRUNCATE TABLE|DELETE FROM|CREATE TRIGGER/i)
  })

  it('does not ALTER any pre-existing table', () => {
    const alteredTables = [...sql.matchAll(/ALTER TABLE "([a-z_]+)"/g)].map((m) => m[1])
    expect(new Set(alteredTables)).toEqual(new Set(['delegation_assertion_jti']))
    expect(statements).not.toMatch(/handoff_token_jti/)
  })

  it('has exactly the designed columns (no payload, actor or body hash)', () => {
    const create = /CREATE TABLE "delegation_assertion_jti" \(([\s\S]*?)\n\);/.exec(sql)?.[1] ?? ''
    const columns = [...create.matchAll(/^\s*"([a-z_]+)" /gm)].map((m) => m[1])
    expect(columns).toEqual(['org_id', 'jti', 'kid', 'expires_at', 'created_at'])
    expect(create).toMatch(/"org_id" uuid NOT NULL/)
    expect(create).toMatch(/"jti" text NOT NULL/)
    expect(create).toMatch(/"kid" text NOT NULL/)
    expect(create).toMatch(/"expires_at" timestamp with time zone NOT NULL/)
    expect(create).toMatch(/"created_at" timestamp with time zone DEFAULT now\(\) NOT NULL/)
  })

  it('has the (org_id, jti) primary key and both byte-length CHECK constraints', () => {
    expect(sql).toMatch(
      /CONSTRAINT "delegation_assertion_jti_org_id_jti_pk" PRIMARY KEY\("org_id","jti"\)/
    )
    expect(sql).toMatch(
      /CONSTRAINT "delegation_assertion_jti_jti_len" CHECK \(octet_length\("delegation_assertion_jti"\."jti"\) BETWEEN 1 AND 128\)/
    )
    expect(sql).toMatch(
      /CONSTRAINT "delegation_assertion_jti_kid_len" CHECK \(octet_length\("delegation_assertion_jti"\."kid"\) BETWEEN 1 AND 128\)/
    )
  })

  it('FKs org_id to organizations ON DELETE cascade and indexes expires_at', () => {
    expect(sql).toMatch(
      /FOREIGN KEY \("org_id"\) REFERENCES "public"\."organizations"\("id"\) ON DELETE cascade/
    )
    expect(sql).toMatch(
      /CREATE INDEX "idx_delegation_assertion_jti_expires_at" ON "delegation_assertion_jti" USING btree \("expires_at"\)/
    )
  })

  it('has RLS enabled and forced, owned by vault_owner', () => {
    expect(sql).toMatch(/ALTER TABLE "delegation_assertion_jti" ENABLE ROW LEVEL SECURITY/)
    expect(sql).toMatch(/ALTER TABLE "delegation_assertion_jti" FORCE ROW LEVEL SECURITY/)
    expect(sql).toMatch(/ALTER TABLE "delegation_assertion_jti" OWNER TO vault_owner/)
  })

  it('has exactly one FOR ALL policy with USING and WITH CHECK on the org predicate', () => {
    const policyBlocks = sql.match(/CREATE POLICY[\s\S]*?;/g) ?? []
    expect(policyBlocks).toHaveLength(1)
    const [block] = policyBlocks
    expect(block).toMatch(/CREATE POLICY delegation_assertion_jti_isolation/)
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
      /REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "delegation_assertion_jti" FROM vault_app;/
    )
    expect(sql).toMatch(/GRANT SELECT, INSERT ON TABLE "delegation_assertion_jti" TO vault_app;/)
    expect(sql).not.toMatch(/GRANT[^;]*(UPDATE|TRUNCATE)[^;]*TO vault_app/i)
    expect(sql).not.toMatch(/GRANT[^;]*DELETE[^;]*TO vault_app/i)
  })

  it('grants vault_admin only the prune columns and DELETE, and nothing to vault_extension', () => {
    const adminGrants = sql.match(/GRANT [^;]* TO vault_admin;/g) ?? []
    expect(adminGrants).toEqual([
      'GRANT SELECT (org_id, jti, expires_at) ON TABLE "delegation_assertion_jti" TO vault_admin;',
      'GRANT DELETE ON TABLE "delegation_assertion_jti" TO vault_admin;',
    ])
    expect(statements).not.toMatch(/vault_extension/)
  })
})
