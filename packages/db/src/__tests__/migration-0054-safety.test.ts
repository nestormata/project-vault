import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const MIGRATION_PATH = resolve(import.meta.dirname, '../migrations/0054_audit_revealed_fields.sql')

describe('migration 0054 safety', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf-8')

  it('adds a single nullable text[] column to audit_log_entries, nothing else', () => {
    expect(sql).toMatch(/ALTER TABLE "audit_log_entries" ADD COLUMN "revealed_fields" text\[\]/)
    expect(sql.match(/ALTER TABLE/g)).toHaveLength(1)
    expect(sql.match(/ADD COLUMN/g)).toHaveLength(1)
  })

  it('is purely additive — no destructive or defaulting statements', () => {
    expect(sql).not.toMatch(/DROP COLUMN|DROP TABLE|RENAME|TRUNCATE|DELETE FROM|NOT NULL|DEFAULT/i)
  })
})
