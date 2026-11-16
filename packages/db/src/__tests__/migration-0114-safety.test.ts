import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  findDestructiveStatements,
  KNOWN_REVIEWED_DESTRUCTIVE_MIGRATIONS,
} from '../lib/migration-safety.js'

const TAG = '0114_webauthn_credentials'
const MIGRATION_PATH = resolve(import.meta.dirname, `../migrations/${TAG}.sql`)

describe('migration 0114 safety', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf-8')
  const statements = sql.replaceAll(/^\s*--(?! statement-breakpoint).*$/gm, '')

  it('creates additive tables and nothing destructive', () => {
    expect(findDestructiveStatements(sql)).toEqual([])
    expect(KNOWN_REVIEWED_DESTRUCTIVE_MIGRATIONS).not.toHaveProperty(TAG)
    expect(statements).not.toMatch(/DROP|RENAME|TRUNCATE|DELETE FROM|CREATE TRIGGER/i)
    expect(statements).not.toMatch(/ALTER TABLE "(users|mfa_enrollments)"/i)
    expect(statements).not.toMatch(/GRANT /i)
    expect(statements).not.toMatch(/ENABLE ROW LEVEL SECURITY/i)
    expect(statements).not.toMatch(/private/i)
    expect(statements).toMatch(/CREATE TABLE "webauthn_credentials"/)
    expect(statements).toMatch(/CREATE TABLE "webauthn_registration_challenges"/)
    expect(statements).toMatch(/"public_key" text NOT NULL/)
    expect(statements).toMatch(/"sign_count" bigint/)
  })
})
