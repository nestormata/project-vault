import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  resolve(import.meta.dirname, '../migrations/0071_admin_pool_role.sql'),
  'utf8'
)

describe('Story 24.2 admin pool migration contract', () => {
  it('creates a non-superuser BYPASSRLS login with explicit grants only', () => {
    expect(migration).toMatch(/CREATE ROLE vault_admin LOGIN/i)
    expect(migration).toMatch(/NOSUPERUSER/i)
    expect(migration).toMatch(/BYPASSRLS/i)
    expect(migration).not.toMatch(/GRANT .* ON ALL TABLES IN SCHEMA/i)
    expect(migration).not.toMatch(/ALTER DEFAULT PRIVILEGES[\s\S]*vault_admin/i)
    expect(migration).toMatch(/GRANT SELECT .*project_invitations/i)
    expect(migration).toMatch(/GRANT DELETE .*notification_inbox/i)
    expect(migration).toMatch(/GRANT SELECT \(id, expires_at\).*notification_inbox/i)
    expect(migration).toMatch(/GRANT SELECT \(id, expires_at\).*pending_imports/i)
  })
})
