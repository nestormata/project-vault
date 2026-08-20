import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  resolve(import.meta.dirname, '../migrations/0081_extension_db_role.sql'),
  'utf8'
)

describe('Story 23.5 extension role migration safety', () => {
  it('creates a non-superuser, no-inherit, no-bypass role and approval table', () => {
    expect(migration).toMatch(
      /CREATE ROLE vault_extension LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT/i
    )
    expect(migration).toMatch(/CREATE TABLE .*extension_db_scope_approvals/i)
  })

  it('does not copy core widening privileges or this story-owned PUBLIC revoke', () => {
    expect(migration).not.toMatch(/ALTER DEFAULT PRIVILEGES/i)
    expect(migration).not.toMatch(/GRANT CREATE ON DATABASE/i)
    expect(migration).not.toMatch(/REVOKE\s+.*FROM\s+PUBLIC/i)
    expect(migration).not.toMatch(/FORCE ROW LEVEL SECURITY/i)
  })

  it('does not grant the extension role access to the approval artifact', () => {
    expect(migration).not.toMatch(/ON\s+extension_db_scope_approvals\s+TO\s+vault_extension/i)
  })
})
