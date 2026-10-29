import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import postgres from 'postgres'
import { SUPERUSER_DATABASE_URL } from '../test-db-urls.js'

const MIGRATION_PATH = resolve(
  import.meta.dirname,
  '../migrations/0106_project_urls_and_soft_delete.sql'
)
const superSql = postgres(SUPERUSER_DATABASE_URL, { max: 1 })

afterAll(async () => {
  await superSql.end()
})

// Story 72-9: project URLs and soft delete columns. Purely additive so the previous app version,
// which never selects or writes them, keeps working during a rolling deploy.
describe('migration 0106 (projects urls and soft delete)', () => {
  const sqlText = readFileSync(MIGRATION_PATH, 'utf-8')
  const statements = sqlText.replaceAll(/^\s*--(?! statement-breakpoint).*$/gm, '')

  it('is purely additive: ALTER TABLE on projects plus one index, nothing destructive', () => {
    const alteredTables = [...statements.matchAll(/ALTER TABLE "?([a-z_]+)"?/g)].map((m) => m[1])
    expect(new Set(alteredTables)).toEqual(new Set(['projects']))
    expect(statements).not.toMatch(/DROP |RENAME|TRUNCATE|DELETE FROM|UPDATE /i)
  })

  it('is idempotent: re-running every statement on a migrated database does not fail', async () => {
    for (const statement of sqlText.split('--> statement-breakpoint')) {
      if (statement.replaceAll(/^\s*--.*$/gm, '').trim() === '') continue
      await expect(superSql.unsafe(statement)).resolves.toBeDefined()
    }
  })

  it('adds urls (not null, default empty array) and nullable deletion columns', async () => {
    const rows = await superSql<
      { column_name: string; is_nullable: string; column_default: string | null }[]
    >`
      SELECT column_name, is_nullable, column_default FROM information_schema.columns
      WHERE table_name = 'projects' AND column_name IN ('urls','deleted_at','deleted_by','purge_after')`
    const byName = Object.fromEntries(rows.map((r) => [r.column_name, r]))
    expect(byName.urls?.is_nullable).toBe('NO')
    expect(byName.urls?.column_default).toMatch(/'\[\]'::jsonb/)
    for (const name of ['deleted_at', 'deleted_by', 'purge_after']) {
      expect(byName[name]?.is_nullable).toBe('YES')
    }
  })

  it('references users(id) ON DELETE SET NULL for deleted_by', async () => {
    const [fk] = await superSql<{ confdeltype: string; target: string }[]>`
      SELECT c.confdeltype, c.confrelid::regclass::text AS target
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      WHERE c.conrelid = 'projects'::regclass AND c.contype = 'f' AND a.attname = 'deleted_by'`
    expect(fk).toEqual({ confdeltype: 'n', target: 'users' })
  })

  it('has the partial purge-due index', async () => {
    const [index] = await superSql<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'projects' AND indexname = 'idx_projects_purge_due'`
    expect(index?.indexdef).toMatch(/\(purge_after\)/)
    expect(index?.indexdef).toMatch(/WHERE \(deleted_at IS NOT NULL\)/)
  })
})
