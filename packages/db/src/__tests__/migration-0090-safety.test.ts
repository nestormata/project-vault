import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const MIGRATION_PATH = resolve(
  import.meta.dirname,
  '../migrations/0090_notification_queue_admin_grant.sql'
)

describe('migration 0090 safety', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf-8')

  it('is a narrow, additive read-only grant only — no schema/column change', () => {
    expect(sql).not.toMatch(/CREATE TABLE|ALTER TABLE|DROP |CREATE POLICY/i)
    const statements = sql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--') && line.trim().length > 0)
      .join('\n')
    expect(statements).not.toMatch(/\bGRANT\s+(DELETE|UPDATE|INSERT)\b/i)
    expect(sql).toMatch(
      /GRANT SELECT \(id, org_id, provider_id, provider_message_id\) ON notification_queue TO vault_admin/
    )
  })
})
