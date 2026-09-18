import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const MIGRATION_PATH = resolve(
  import.meta.dirname,
  '../migrations/0095_extension_scheduled_task_runs.sql'
)

describe('migration 0095 safety', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf-8')

  it('creates exactly one new table, additively (Story 56.1 Task 3)', () => {
    expect(sql).toMatch(/CREATE TABLE "extension_scheduled_task_runs"/)
    expect(sql.match(/CREATE TABLE/g)).toHaveLength(1)
    expect(sql).not.toMatch(/DROP TABLE|DROP COLUMN|RENAME|TRUNCATE|DELETE FROM/i)
  })

  it('does not ALTER any pre-existing table (additive-only)', () => {
    expect(sql).not.toMatch(/ALTER TABLE "organizations"/)
    expect(sql).not.toMatch(/ALTER TABLE "projects"/)
    expect(sql).not.toMatch(/ALTER TABLE "extension_lifecycle_events"/)
  })

  it('has exactly the columns Task 3 specifies', () => {
    expect(sql).toMatch(/"id" uuid PRIMARY KEY DEFAULT gen_random_uuid\(\) NOT NULL/)
    expect(sql).toMatch(/"org_id" uuid NOT NULL/)
    expect(sql).toMatch(/"extension_id" text NOT NULL/)
    expect(sql).toMatch(/"task_name" text NOT NULL/)
    expect(sql).toMatch(/"last_run_at" timestamp with time zone/)
    expect(sql).toMatch(/"last_outcome" text/)
    expect(sql).toMatch(/"created_at" timestamp with time zone DEFAULT now\(\) NOT NULL/)
    expect(sql).toMatch(/"updated_at" timestamp with time zone DEFAULT now\(\) NOT NULL/)
  })

  it('extension_id is a plain text column, not an FK (no per-org install table exists)', () => {
    expect(sql).not.toMatch(/extension_id.*REFERENCES/)
    expect(sql.match(/FOREIGN KEY/g)).toHaveLength(1)
  })

  it('FK-CASCADEs org_id to organizations(id)', () => {
    expect(sql).toMatch(
      /ALTER TABLE "extension_scheduled_task_runs" ADD CONSTRAINT .* FOREIGN KEY \("org_id"\) REFERENCES "public"\."organizations"\("id"\) ON DELETE cascade/
    )
  })

  it('has a unique index on (extension_id, task_name, org_id)', () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "uq_extension_scheduled_task_runs_extension_task_org" ON "extension_scheduled_task_runs" USING btree \("extension_id","task_name","org_id"\)/
    )
  })

  it('has an index on org_id', () => {
    expect(sql).toMatch(
      /CREATE INDEX "idx_extension_scheduled_task_runs_org_id" ON "extension_scheduled_task_runs" USING btree \("org_id"\)/
    )
  })

  it('has RLS enabled and forced, owned by vault_owner (matching 0084/0092 conventions)', () => {
    expect(sql).toMatch(/ALTER TABLE "extension_scheduled_task_runs" ENABLE ROW LEVEL SECURITY/)
    expect(sql).toMatch(/ALTER TABLE "extension_scheduled_task_runs" FORCE ROW LEVEL SECURITY/)
    expect(sql).toMatch(/ALTER TABLE "extension_scheduled_task_runs" OWNER TO vault_owner/)
  })

  it('policy is FOR ALL with both USING and WITH CHECK on the same org_id predicate (mirrors 0092)', () => {
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
      /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "extension_scheduled_task_runs" TO vault_app/
    )
  })
})
