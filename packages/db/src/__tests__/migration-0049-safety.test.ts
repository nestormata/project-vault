import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const MIGRATION_PATH = resolve(
  import.meta.dirname,
  '../migrations/0049_credentials_current_version_id_backfill.sql'
)

// Strips full-line SQL comments so assertions below only inspect executable statement text, not
// prose in the migration's own header/inline documentation (which legitimately discusses these
// exact keywords/column names while explaining why they're absent from the real statements).
function stripCommentLines(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
}

describe('migration 0049 safety', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf-8')
  const code = stripCommentLines(sql)

  it('adds current_version_id nullable with no DEFAULT (guarded-migrate.ts destructive-pattern check, AC-3)', () => {
    expect(code).toMatch(
      /ALTER TABLE "credentials" ADD COLUMN IF NOT EXISTS "current_version_id" uuid REFERENCES "credential_versions"\("id"\);/
    )
    // Must not be declared NOT NULL anywhere for this column — that would either be rejected by
    // guarded-migrate.ts (no DEFAULT) or, even with one, break AC-5's "skip zero-version rows"
    // requirement.
    const currentVersionIdLine = code
      .split('\n')
      .find((line) => line.includes('"current_version_id"'))
    expect(currentVersionIdLine).not.toMatch(/NOT NULL/)
  })

  it('adds schema_version as a safe NOT NULL DEFAULT 1 column addition (AC-4)', () => {
    expect(sql).toMatch(
      /ALTER TABLE "credential_versions" ADD COLUMN IF NOT EXISTS "schema_version" smallint NOT NULL DEFAULT 1;/
    )
  })

  it('adds field_meta nullable with no default (AC-4)', () => {
    expect(sql).toMatch(
      /ALTER TABLE "credential_versions" ADD COLUMN IF NOT EXISTS "field_meta" jsonb;/
    )
  })

  it('never uses a destructive pattern (DROP COLUMN, DROP TABLE, TRUNCATE, DELETE FROM)', () => {
    expect(sql).not.toMatch(/DROP COLUMN|DROP TABLE|TRUNCATE|DELETE FROM/i)
  })

  it('the backfill UPDATE is guarded by current_version_id IS NULL (AC-7 re-run safety)', () => {
    expect(sql).toMatch(/AND c\.current_version_id IS NULL;/)
  })

  it('every RAISE NOTICE references only the credential id or aggregate counts — never encrypted_value or plaintext (AC-7)', () => {
    const noticeLines = code.match(/RAISE NOTICE[^;]*;/gs) ?? []
    expect(noticeLines.length).toBeGreaterThan(0)
    for (const line of noticeLines) {
      expect(line).not.toMatch(/encrypted_value/i)
      expect(line).not.toMatch(/ciphertext|plaintext/i)
    }
    // The per-row skip notice interpolates exactly orphan.id — no other column.
    expect(code).toMatch(/RAISE NOTICE 'credential % skipped:[^,]*', orphan\.id;/)
  })
})
