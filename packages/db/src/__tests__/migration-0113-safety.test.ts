import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  findDestructiveStatements,
  KNOWN_REVIEWED_DESTRUCTIVE_MIGRATIONS,
} from '../lib/migration-safety.js'

const MIGRATION_PATH = resolve(import.meta.dirname, '../migrations/0113_handoff_display_claims.sql')

describe('migration 0113 safety', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf-8')
  const statements = sql.replaceAll(/^\s*--(?! statement-breakpoint).*$/gm, '')

  it('adds the display jsonb columns and nothing destructive', () => {
    expect(findDestructiveStatements(sql)).toEqual([])
    expect(KNOWN_REVIEWED_DESTRUCTIVE_MIGRATIONS).not.toHaveProperty('0113_handoff_display_claims')
    expect(statements).not.toMatch(/DROP|RENAME|TRUNCATE|DELETE FROM|CREATE TRIGGER/i)
    expect(statements.match(/ALTER TABLE "([a-z_]+)" ADD COLUMN/g)).toEqual([
      'ALTER TABLE "sessions" ADD COLUMN',
      'ALTER TABLE "pending_mfa_sessions" ADD COLUMN',
    ])
    expect(statements).toMatch(
      /ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "handoff_display_claims" jsonb/
    )
    expect(statements).toMatch(
      /ALTER TABLE "pending_mfa_sessions" ADD COLUMN IF NOT EXISTS "handoff_display_claims" jsonb/
    )
  })
})
