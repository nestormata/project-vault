import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const MIGRATION_PATH = resolve(
  import.meta.dirname,
  '../migrations/0082_project_creation_idempotency.sql'
)

describe('Story 23.10 migration safety', () => {
  it('adds the nullable native-project idempotency column and rerunnable unique index', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf8')
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS[\s\S]*creation_request_id[" ]+uuid/i)
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS[\s\S]*idx_projects_creation_request_id/i)
    expect(sql).toMatch(/WHERE "creation_request_id" IS NOT NULL/i)
    expect(sql).not.toMatch(/DROP TABLE|DROP COLUMN|TRUNCATE/i)
  })
})
