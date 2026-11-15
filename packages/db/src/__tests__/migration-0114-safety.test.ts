import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  findDestructiveStatements,
  KNOWN_REVIEWED_DESTRUCTIVE_MIGRATIONS,
} from '../lib/migration-safety.js'

const MIGRATION_PATH = resolve(
  import.meta.dirname,
  '../migrations/0114_identity_revocation_jti.sql'
)

describe('migration 0114 safety', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf-8')
  const statements = sql.replaceAll(/^\s*--(?! statement-breakpoint).*$/gm, '')

  it('creates identity_revocation_jti only and nothing destructive', () => {
    expect(statements.match(/CREATE TABLE "([a-z_]+)"/g)).toEqual([
      'CREATE TABLE "identity_revocation_jti"',
    ])
    expect(findDestructiveStatements(sql)).toEqual([])
    expect(KNOWN_REVIEWED_DESTRUCTIVE_MIGRATIONS).not.toHaveProperty('0114_identity_revocation_jti')
    expect(statements).not.toMatch(
      /DROP TABLE|RENAME|TRUNCATE|DELETE FROM|CREATE TRIGGER|ALTER TABLE|CREATE FUNCTION|SECURITY DEFINER/i
    )
  })

  it('has exactly the designed columns and jti length check', () => {
    const create = /CREATE TABLE "identity_revocation_jti" \(([\s\S]*?)\n\);/.exec(sql)?.[1] ?? ''
    const columns = [...create.matchAll(/^\s*"([a-z_]+)" /gm)].map((m) => m[1])
    expect(columns).toEqual(['jti', 'expires_at', 'created_at'])
    expect(create).toMatch(/"jti" text PRIMARY KEY NOT NULL/)
    expect(create).toMatch(/"expires_at" timestamp with time zone NOT NULL/)
    expect(create).toMatch(/"created_at" timestamp with time zone DEFAULT now\(\) NOT NULL/)
    expect(create).toMatch(
      /CONSTRAINT "identity_revocation_jti_jti_len" CHECK \(octet_length\("identity_revocation_jti"\."jti"\) BETWEEN 1 AND 128\)/
    )
  })

  it('indexes expires_at for the prune job', () => {
    expect(sql).toMatch(
      /CREATE INDEX "idx_identity_revocation_jti_expires_at" ON "identity_revocation_jti" USING btree \("expires_at"\)/
    )
  })

  it('has no table RLS and no ACL statements (no tenant is known yet, default privileges apply)', () => {
    expect(statements).not.toMatch(/ROW LEVEL SECURITY|CREATE POLICY|GRANT|REVOKE|OWNER TO/)
    expect(statements).not.toMatch(/vault_extension/)
  })
})
