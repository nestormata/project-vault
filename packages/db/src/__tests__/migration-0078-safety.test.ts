import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const MIGRATION_PATH = resolve(
  import.meta.dirname,
  '../migrations/0078_audit_log_entries_extension_actor_type.sql'
)

describe('migration 0078 safety', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf-8')

  it('only rewrites audit_log_entries_actor_type_check to widen it, no other destructive statement', () => {
    expect(sql.match(/DROP CONSTRAINT/g)).toHaveLength(1)
    expect(sql.match(/ADD CONSTRAINT/g)).toHaveLength(1)
    expect(sql).toMatch(/DROP CONSTRAINT "audit_log_entries_actor_type_check"/)
    expect(sql).toMatch(
      /CHECK \("audit_log_entries"\."actor_type" IN \('human','machine_user','system','extension'\)\)/
    )
    expect(sql).not.toMatch(/DROP COLUMN|DROP TABLE|RENAME|TRUNCATE|DELETE FROM/i)
  })

  it('retains every pre-existing allowed actor_type value (additive-only widening)', () => {
    const match = sql.match(/CHECK \("audit_log_entries"\."actor_type" IN \(([^)]+)\)\)/)
    expect(match).not.toBeNull()
    const values = (match?.[1] ?? '').split(',').map((v) => v.trim())
    expect(values).toEqual(["'human'", "'machine_user'", "'system'", "'extension'"])
  })

  it('does not touch any other table', () => {
    const alterTableTargets = [...sql.matchAll(/ALTER TABLE "(\w+)"/g)].map((m) => m[1])
    expect(new Set(alterTableTargets)).toEqual(new Set(['audit_log_entries']))
  })
})
