import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import postgres from 'postgres'
import { SUPERUSER_DATABASE_URL } from '../test-db-urls.js'

const MIGRATION_PATH = resolve(import.meta.dirname, '../migrations/0104_rotation_owner_user_id.sql')
const superSql = postgres(SUPERUSER_DATABASE_URL, { max: 1 })

afterAll(async () => {
  await superSql.end()
})

// Story 43-17 AC-1/KD-1: ownership moves in its own nullable column; `initiated_by` is never
// rewritten. Purely additive so the previous app version, which never selects it, keeps working.
describe('migration 0104 (rotations.owner_user_id)', () => {
  const sqlText = readFileSync(MIGRATION_PATH, 'utf-8')
  const statements = sqlText.replaceAll(/^\s*--(?! statement-breakpoint).*$/gm, '')

  it('is purely additive: ALTER TABLE on rotations plus one index, nothing destructive', () => {
    const alteredTables = [...statements.matchAll(/ALTER TABLE "?([a-z_]+)"?/g)].map((m) => m[1])
    expect(new Set(alteredTables)).toEqual(new Set(['rotations']))
    expect(statements).not.toMatch(/DROP |RENAME|TRUNCATE|DELETE FROM|UPDATE /i)
    expect(statements).not.toMatch(/ADD COLUMN[^;]*NOT NULL/i)
  })

  it('is idempotent: re-running every statement on a migrated database does not fail', async () => {
    for (const statement of sqlText.split('--> statement-breakpoint')) {
      if (statement.replaceAll(/^\s*--.*$/gm, '').trim() === '') continue
      await superSql.unsafe(statement)
    }
  })

  it('adds a nullable uuid column', async () => {
    const [column] = await superSql<{ data_type: string; is_nullable: string }[]>`
      SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_name = 'rotations' AND column_name = 'owner_user_id'`
    expect(column).toEqual({ data_type: 'uuid', is_nullable: 'YES' })
  })

  it('references users(id) ON DELETE SET NULL (not restrict, not cascade)', async () => {
    const [fk] = await superSql<{ confdeltype: string; target: string }[]>`
      SELECT c.confdeltype, c.confrelid::regclass::text AS target
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      WHERE c.conrelid = 'rotations'::regclass AND c.contype = 'f' AND a.attname = 'owner_user_id'`
    expect(fk).toEqual({ confdeltype: 'n', target: 'users' })
  })

  it('has the partial blocking-owner index', async () => {
    const [index] = await superSql<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'rotations' AND indexname = 'idx_rotations_owner_blocking'`
    expect(index?.indexdef).toMatch(/\(org_id, owner_user_id\)/)
    expect(index?.indexdef).toMatch(/WHERE \(owner_user_id IS NOT NULL\)/)
  })
})
