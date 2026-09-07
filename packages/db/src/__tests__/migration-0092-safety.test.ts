import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const MIGRATION_PATH = resolve(
  import.meta.dirname,
  '../migrations/0092_extension_lifecycle_events.sql'
)

describe('migration 0092 safety', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf-8')

  it('creates exactly one new table, additively (Story 35.1 Design Decision 4/Task 2)', () => {
    expect(sql).toMatch(/CREATE TABLE "extension_lifecycle_events"/)
    expect(sql.match(/CREATE TABLE/g)).toHaveLength(1)
    expect(sql).not.toMatch(/DROP TABLE|DROP COLUMN|RENAME|TRUNCATE|DELETE FROM/i)
  })

  it('does not ALTER any pre-existing table (additive-only)', () => {
    expect(sql).not.toMatch(/ALTER TABLE "organizations"/)
    expect(sql).not.toMatch(/ALTER TABLE "projects"/)
    expect(sql).not.toMatch(/ALTER TABLE "notification_queue"/)
  })

  it('has exactly the columns Design Decision 4 specifies', () => {
    expect(sql).toMatch(/"id" uuid PRIMARY KEY DEFAULT gen_random_uuid\(\) NOT NULL/)
    expect(sql).toMatch(/"org_id" uuid NOT NULL/)
    expect(sql).toMatch(/"project_id" uuid NOT NULL/)
    expect(sql).toMatch(/"event_type" text NOT NULL/)
    expect(sql).toMatch(/"payload" jsonb NOT NULL/)
    expect(sql).toMatch(/"status" text DEFAULT 'pending' NOT NULL/)
    expect(sql).toMatch(/"attempt_count" integer DEFAULT 0 NOT NULL/)
    expect(sql).toMatch(/"last_attempt_at" timestamp with time zone/)
    expect(sql).toMatch(/"last_error" text/)
    expect(sql).toMatch(/"created_at" timestamp with time zone DEFAULT now\(\) NOT NULL/)
    expect(sql).toMatch(/"delivered_at" timestamp with time zone/)
  })

  it('event_type is an open text column, not a narrow CHECK enum (Design Decision 7 extensibility)', () => {
    // Only the CODE (not comment prose) matters here — the migration's own comments legitimately
    // mention "event_type" and "CHECK" together in prose explaining this very design decision.
    const codeOnly = sql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
    expect(codeOnly).toMatch(/"event_type" text NOT NULL/)
    expect(codeOnly).not.toMatch(/event_type.*CHECK/)
    expect(codeOnly).not.toMatch(/CHECK.*event_type/)
  })

  it('status is constrained to exactly pending|delivered|failed', () => {
    expect(sql).toMatch(
      /CONSTRAINT "extension_lifecycle_events_status_check" CHECK \("extension_lifecycle_events"\."status" IN \('pending','delivered','failed'\)\)/
    )
  })

  it('FK-CASCADEs org_id to organizations(id) and project_id to projects(id)', () => {
    expect(sql).toMatch(
      /ALTER TABLE "extension_lifecycle_events" ADD CONSTRAINT .* FOREIGN KEY \("org_id"\) REFERENCES "public"\."organizations"\("id"\) ON DELETE cascade/
    )
    expect(sql).toMatch(
      /ALTER TABLE "extension_lifecycle_events" ADD CONSTRAINT .* FOREIGN KEY \("project_id"\) REFERENCES "public"\."projects"\("id"\) ON DELETE cascade/
    )
  })

  it('has a partial pending index mirroring idx_notification_queue_pending', () => {
    expect(sql).toMatch(
      /CREATE INDEX "idx_extension_lifecycle_events_pending" ON "extension_lifecycle_events" USING btree \("org_id","status"\) WHERE "extension_lifecycle_events"\."status" = 'pending'/
    )
  })

  it('has a created_at index mirroring idx_notification_queue_created_at', () => {
    expect(sql).toMatch(
      /CREATE INDEX "idx_extension_lifecycle_events_created_at" ON "extension_lifecycle_events" USING btree \("created_at"\)/
    )
  })

  it('has RLS enabled and forced, owned by vault_owner (AC4, matching Story 24.1/0084 conventions)', () => {
    expect(sql).toMatch(/ALTER TABLE "extension_lifecycle_events" ENABLE ROW LEVEL SECURITY/)
    expect(sql).toMatch(/ALTER TABLE "extension_lifecycle_events" FORCE ROW LEVEL SECURITY/)
    expect(sql).toMatch(/ALTER TABLE "extension_lifecycle_events" OWNER TO vault_owner/)
  })

  it('policy is FOR ALL with both USING and WITH CHECK on the same org_id predicate (mirrors 0084)', () => {
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
      /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "extension_lifecycle_events" TO vault_app/
    )
  })
})
