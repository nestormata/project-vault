import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { adminAlerts, backupRuns, users } from './index.js'
import { EXCLUDED_TABLES } from '../check-rls-coverage.js'

describe('Story 9.1 platform-operator and backup schema', () => {
  it('exposes users.is_platform_operator (D1/AC-1)', () => {
    expect(users.isPlatformOperator).toBeDefined()
  })

  it('exposes backup_runs columns (D3/AC-2)', () => {
    expect(backupRuns.id).toBeDefined()
    expect(backupRuns.filename).toBeDefined()
    expect(backupRuns.status).toBeDefined()
    expect(backupRuns.triggeredBy).toBeDefined()
    expect(backupRuns.triggeredByUserId).toBeDefined()
    expect(backupRuns.startedAt).toBeDefined()
    expect(backupRuns.completedAt).toBeDefined()
    expect(backupRuns.sizeBytes).toBeDefined()
    expect(backupRuns.keyVersion).toBeDefined()
    expect(backupRuns.checksumSha256).toBeDefined()
    expect(backupRuns.verified).toBeDefined()
    expect(backupRuns.errorMessage).toBeDefined()
  })

  it('exposes admin_alerts columns (D3/AC-2)', () => {
    expect(adminAlerts.id).toBeDefined()
    expect(adminAlerts.alertType).toBeDefined()
    expect(adminAlerts.severity).toBeDefined()
    expect(adminAlerts.payload).toBeDefined()
    expect(adminAlerts.status).toBeDefined()
    expect(adminAlerts.createdAt).toBeDefined()
    expect(adminAlerts.acknowledgedAt).toBeDefined()
  })

  // D3: both tables are platform-level (whole-instance, no org_id column) — same
  // EXCLUDED_TABLES/RLS-coverage-exception pattern as vault_state/api_instances, following the
  // established convention in this file's siblings (auth-sessions-schema.test.ts,
  // user-onboarding-schema.test.ts) rather than a live policy-drop test, since neither table has
  // an org_id column for checkRlsCoverage's generic scan to ever flag in the first place — the
  // membership assertion below is what actually guards against someone silently removing the
  // documented exclusion.
  it('documents backup_runs and admin_alerts as RLS coverage exceptions', () => {
    expect(EXCLUDED_TABLES.has('backup_runs')).toBe(true)
    expect(EXCLUDED_TABLES.has('admin_alerts')).toBe(true)
  })

  // AC-3/AC-19 item 4: the migration adding is_platform_operator must NEVER auto-promote an
  // existing user — this is a privilege-escalation bug, not a convenience (see D1's resolution).
  // A code-review checklist item alone is not durable; assert it directly against the migration
  // file's actual SQL content so a future edit re-introducing such an UPDATE fails CI.
  it('AC-3: the platform-operator migration contains no UPDATE statement against users', () => {
    const migrationsDir = resolve(import.meta.dirname, '../migrations')
    const migrationFile = readdirSync(migrationsDir).find(
      (name) => name.startsWith('0038_') && name.endsWith('.sql')
    )
    expect(
      migrationFile,
      'expected the 0038 platform-operator migration file to exist'
    ).toBeTruthy()

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- migrationFile is derived from readdirSync's own listing of the fixed migrations directory, never user input.
    const sql = readFileSync(resolve(migrationsDir, migrationFile as string), 'utf8')
    // Strip SQL line-comments first — this file's own Dev Notes-style comments deliberately
    // reference the exact forbidden pattern as documentation of what NOT to do (D1), which would
    // otherwise false-positive against a naive whole-file match.
    const sqlWithoutComments = sql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
    // Loosely matches any UPDATE targeting the users table, case-insensitive, ignoring quoting.
    expect(sqlWithoutComments).not.toMatch(/UPDATE\s+"?users"?\s+SET/i)
  })
})
