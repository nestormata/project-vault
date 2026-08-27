import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const MIGRATION_PATH = resolve(
  import.meta.dirname,
  '../migrations/0085_extension_ephemeral_state_admin_grant.sql'
)

describe('migration 0085 safety', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf-8')

  it('is a narrow, additive grant only — no schema/column change', () => {
    expect(sql).not.toMatch(/CREATE TABLE|ALTER TABLE|DROP |CREATE POLICY/i)
    expect(sql).toMatch(
      /GRANT SELECT \(id, expires_at\) ON extension_ephemeral_state TO vault_admin/
    )
    expect(sql).toMatch(/GRANT DELETE ON extension_ephemeral_state TO vault_admin/)
  })
})
