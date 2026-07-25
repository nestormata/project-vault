import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const MIGRATION_PATH = resolve(
  import.meta.dirname,
  '../migrations/0050_staged_rotation_state_machine.sql'
)

describe('migration 0050 safety', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf-8')

  it('only rewrites rotations_status_check to widen it, no other destructive statement', () => {
    expect(sql.match(/DROP CONSTRAINT/g)).toHaveLength(1)
    expect(sql.match(/ADD CONSTRAINT/g)).toHaveLength(1)
    expect(sql).toMatch(/DROP CONSTRAINT "rotations_status_check"/)
    expect(sql).toMatch(
      /CHECK \("rotations"\."status" IN \('in_progress','staged','promoted','retired','completed','abandoned','stale_recovery','break_glass_complete'\)\)/
    )
    expect(sql).not.toMatch(/DROP COLUMN|DROP TABLE|RENAME|TRUNCATE|DELETE FROM/i)
  })

  it('widens idx_rotations_one_active_per_credential to include staged and promoted', () => {
    expect(sql).toMatch(/IN \('in_progress', 'staged', 'promoted', 'stale_recovery'\)/)
  })

  it('backfills version-level promoted_at before flipping rotation status, and status flip is last', () => {
    const versionBackfillIndex = sql.indexOf('UPDATE "credential_versions"\nSET "promoted_at"')
    const statusFlipIndex = sql.indexOf('SET "status" = \'promoted\'')
    expect(versionBackfillIndex).toBeGreaterThan(-1)
    expect(statusFlipIndex).toBeGreaterThan(-1)
    expect(statusFlipIndex).toBeGreaterThan(versionBackfillIndex)
  })
})
