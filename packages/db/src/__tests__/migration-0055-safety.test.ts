import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const MIGRATION_PATH = resolve(
  import.meta.dirname,
  '../migrations/0055_rotation_target_fields_and_dependency_field_key.sql'
)

describe('migration 0055 safety', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf-8')

  it('adds target_fields text[] to rotations and field_key text to credential_dependencies, nothing else', () => {
    expect(sql).toMatch(/ALTER TABLE "rotations" ADD COLUMN "target_fields" text\[\]/)
    expect(sql).toMatch(/ALTER TABLE "credential_dependencies" ADD COLUMN "field_key" text/)
    expect(sql.match(/ALTER TABLE/g)).toHaveLength(2)
    expect(sql.match(/ADD COLUMN/g)).toHaveLength(2)
  })

  it('is purely additive — no destructive or defaulting statements', () => {
    expect(sql).not.toMatch(/DROP COLUMN|DROP TABLE|RENAME|TRUNCATE|DELETE FROM|NOT NULL|DEFAULT/i)
  })
})
