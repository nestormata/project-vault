import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const MIGRATION_PATH = resolve(
  import.meta.dirname,
  '../migrations/0100_extension_scheduled_task_runs_last_attempt_at.sql'
)

/** Story 56.2 AC1 / T23 — the attempt-bookkeeping column is purely additive. */
describe('migration 0100 safety', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf-8')
  const statements = sql
    .split('--> statement-breakpoint')
    .map((statement) =>
      statement
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim()
    )
    .filter((statement) => statement.length > 0)

  it('documents the story that introduced it', () => {
    expect(sql).toMatch(/^-- Story 56\.2 AC1/)
  })

  it('adds exactly one nullable last_attempt_at column and nothing else', () => {
    expect(statements).toEqual([
      'ALTER TABLE "extension_scheduled_task_runs" ADD COLUMN "last_attempt_at" timestamp with time zone;',
    ])
  })

  it('has no default, NOT NULL, backfill, or destructive/RLS change', () => {
    const executable = statements.join('\n')
    expect(executable).not.toMatch(/NOT NULL|DEFAULT|UPDATE |DROP |RENAME|TRUNCATE|DELETE FROM/i)
    expect(executable).not.toMatch(/POLICY|ROW LEVEL SECURITY|GRANT|REVOKE|OWNER TO/i)
  })
})
