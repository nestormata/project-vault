import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  findDestructiveStatements,
  KNOWN_REVIEWED_DESTRUCTIVE_MIGRATIONS,
} from '../lib/migration-safety.js'

const MIGRATION_PATH = resolve(import.meta.dirname, '../migrations/0108_handoff_nonces.sql')

// Story 73.1 D6: one new no-RLS table for the browser-bound handoff nonce. Additive only, so the
// guarded migrator applies it in place: no DROP, no GRANT (vault_app's CRUD comes from the schema
// default privileges, exactly like handoff_token_jti in 0087).
describe('migration 0108 safety', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf-8')
  const statements = sql.replaceAll(/^\s*--(?! statement-breakpoint).*$/gm, '')

  it('creates exactly handoff_nonces and nothing destructive', () => {
    expect(statements.match(/CREATE TABLE "([a-z_]+)"/g)).toEqual(['CREATE TABLE "handoff_nonces"'])
    expect(findDestructiveStatements(sql)).toEqual([])
    expect(KNOWN_REVIEWED_DESTRUCTIVE_MIGRATIONS).not.toHaveProperty('0108_handoff_nonces')
    expect(statements).not.toMatch(/DROP|RENAME|TRUNCATE|DELETE FROM|CREATE TRIGGER|ALTER TABLE/i)
  })

  it('has exactly the designed columns', () => {
    const create = /CREATE TABLE "handoff_nonces" \(([\s\S]*?)\n\);/.exec(sql)?.[1] ?? ''
    const columns = [...create.matchAll(/^\s*"([a-z_]+)" /gm)].map((m) => m[1])
    expect(columns).toEqual(['nonce_hash', 'expires_at', 'consumed_at', 'created_at'])
    expect(create).toMatch(/"nonce_hash" text PRIMARY KEY NOT NULL/)
    expect(create).toMatch(/"expires_at" timestamp with time zone NOT NULL/)
    expect(create).toMatch(/"consumed_at" timestamp with time zone,/)
    expect(create).toMatch(/"created_at" timestamp with time zone DEFAULT now\(\) NOT NULL/)
  })

  it('indexes expires_at for the prune job', () => {
    expect(sql).toMatch(
      /CREATE INDEX "idx_handoff_nonces_expires_at" ON "handoff_nonces" USING btree \("expires_at"\)/
    )
  })

  it('has no RLS and no ACL statements (no tenant is known yet, default privileges apply)', () => {
    expect(statements).not.toMatch(/ROW LEVEL SECURITY|CREATE POLICY|GRANT|REVOKE|OWNER TO/)
  })
})
