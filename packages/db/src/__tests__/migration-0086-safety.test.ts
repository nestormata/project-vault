import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const MIGRATION_PATH = resolve(import.meta.dirname, '../migrations/0086_credentials_archive.sql')

describe('migration 0086 safety (Story 28.5 AC1)', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf-8')

  it('only ALTERs credentials — additive, no new table, no destructive statement', () => {
    expect(sql).toMatch(/ALTER TABLE "credentials" ADD COLUMN "archived_at"/)
    expect(sql).toMatch(/ALTER TABLE "credentials" ADD COLUMN "archived_by"/)
    expect(sql).not.toMatch(/CREATE TABLE/)
    expect(sql).not.toMatch(/DROP TABLE|DROP COLUMN|RENAME|TRUNCATE/i)
    // AC1: "No DELETE SQL statement, no ON DELETE-triggered hard removal of a credentials row"
    expect(sql).not.toMatch(/\bDELETE FROM\b/i)
  })

  it('adds archivedAt/archivedBy mirroring credential_dependencies exact shape', () => {
    expect(sql).toMatch(/"archived_at" timestamp with time zone/)
    expect(sql).toMatch(/"archived_by" uuid/)
  })

  it('FK archived_by to users(id) ON DELETE SET NULL', () => {
    expect(sql).toMatch(
      /ALTER TABLE "credentials" ADD CONSTRAINT "credentials_archived_by_users_id_fk" FOREIGN KEY \("archived_by"\) REFERENCES "public"\."users"\("id"\) ON DELETE set null/
    )
  })

  it('adds idx_credentials_project_active on (project_id, archived_at)', () => {
    expect(sql).toMatch(
      /CREATE INDEX "idx_credentials_project_active" ON "credentials" USING btree \("project_id","archived_at"\)/
    )
  })
})
