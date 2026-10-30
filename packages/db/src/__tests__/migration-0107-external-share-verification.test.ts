import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import postgres from 'postgres'
import { SUPERUSER_DATABASE_URL } from '../test-db-urls.js'

const MIGRATION_PATH = resolve(
  import.meta.dirname,
  '../migrations/0107_external_share_verification.sql'
)
const superSql = postgres(SUPERUSER_DATABASE_URL, { max: 1 })

afterAll(async () => {
  await superSql.end()
})

function migrationStatements(): string[] {
  return readFileSync(MIGRATION_PATH, 'utf-8')
    .split('--> statement-breakpoint')
    .filter((statement) => statement.replaceAll(/^\s*--.*$/gm, '').trim() !== '')
}

type ColumnRow = {
  column_name: string
  data_type: string
  is_nullable: string
  column_default: string | null
}

// Story 72-11 V1: guest recipient verification lives in additive columns on credential_shares
// (no new table, so no new RLS surface). Every existing row reads back as not gated.
describe('migration 0107 (credential_shares guest verification columns)', () => {
  it('is purely additive: only ALTER TABLE credential_shares ADD COLUMN, nothing destructive', () => {
    const sqlText = migrationStatements()
      .join('\n')
      .replaceAll(/^\s*--.*$/gm, '')
    const alteredTables = [...sqlText.matchAll(/ALTER TABLE "?([a-z_]+)"?/g)].map((m) => m[1])
    expect(new Set(alteredTables)).toEqual(new Set(['credential_shares']))
    expect(sqlText).not.toMatch(/DROP |RENAME|TRUNCATE|DELETE FROM|UPDATE /i)
    expect(sqlText).not.toMatch(/CREATE TABLE/i)
  })

  it('is idempotent: re-running every statement on a migrated database does not fail', async () => {
    // Statements must run in order; chain them instead of awaiting inside a loop.
    const results = await migrationStatements().reduce<Promise<unknown[]>>(
      async (previous, statement) => [...(await previous), await superSql.unsafe(statement)],
      Promise.resolve([])
    )
    expect(results).toHaveLength(migrationStatements().length)
  })

  it('adds the verification columns with the decided types, nullability and defaults', async () => {
    const rows = await superSql<ColumnRow[]>`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'credential_shares' AND column_name IN (
        'verification_required', 'verification_code_hash', 'verification_code_expires_at',
        'verification_attempt_count', 'verification_send_count', 'verification_sent_at',
        'verification_proof_hash', 'verified_at', 'locked_at'
      )`
    const byName = Object.fromEntries(rows.map((row) => [row.column_name, row]))
    expect(byName['verification_required']).toEqual({
      column_name: 'verification_required',
      data_type: 'boolean',
      is_nullable: 'NO',
      column_default: 'false',
    })
    for (const name of ['verification_attempt_count', 'verification_send_count']) {
      expect(byName[name]).toEqual({
        column_name: name,
        data_type: 'integer',
        is_nullable: 'NO',
        column_default: '0',
      })
    }
    for (const name of ['verification_code_hash', 'verification_proof_hash']) {
      expect(byName[name]?.data_type).toBe('text')
      expect(byName[name]?.is_nullable).toBe('YES')
    }
    for (const name of [
      'verification_code_expires_at',
      'verification_sent_at',
      'verified_at',
      'locked_at',
    ]) {
      expect(byName[name]?.data_type).toBe('timestamp with time zone')
      expect(byName[name]?.is_nullable).toBe('YES')
    }
  })

  it('keeps credential_shares under forced row-level security', async () => {
    const [table] = await superSql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'credential_shares'`
    expect(table).toEqual({ relrowsecurity: true, relforcerowsecurity: true })
  })
})
