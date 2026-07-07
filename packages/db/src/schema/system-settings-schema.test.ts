import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { systemSettings, vaultState } from './index.js'
import { EXCLUDED_TABLES } from '../check-rls-coverage.js'

describe('Story 9.2 system_settings / vault_state.key_rotated_at schema (D3, D8, AC-7)', () => {
  it('exposes system_settings columns (D3)', () => {
    expect(systemSettings.id).toBeDefined()
    expect(systemSettings.smtpHost).toBeDefined()
    expect(systemSettings.smtpPort).toBeDefined()
    expect(systemSettings.smtpSecure).toBeDefined()
    expect(systemSettings.smtpUser).toBeDefined()
    expect(systemSettings.smtpPassEncrypted).toBeDefined()
    expect(systemSettings.smtpFrom).toBeDefined()
    expect(systemSettings.backupScheduleOverride).toBeDefined()
    expect(systemSettings.backupRetentionCountOverride).toBeDefined()
    expect(systemSettings.defaultSlackWebhookUrl).toBeDefined()
    expect(systemSettings.maxOrgs).toBeDefined()
    expect(systemSettings.maxUsersPerOrg).toBeDefined()
    expect(systemSettings.sessionIdleTimeoutMinutesOverride).toBeDefined()
    expect(systemSettings.updatedAt).toBeDefined()
    expect(systemSettings.updatedByUserId).toBeDefined()
  })

  it('exposes vault_state.key_rotated_at (D8)', () => {
    expect(vaultState.keyRotatedAt).toBeDefined()
  })

  it('documents system_settings as an RLS coverage exception (D3/AC-7)', () => {
    expect(EXCLUDED_TABLES.has('system_settings')).toBe(true)
  })

  it('the migration backfills vault_state.key_rotated_at from initialized_at and never auto-inserts a system_settings row (AC-7/AC-24)', () => {
    const migrationsDir = resolve(import.meta.dirname, '../migrations')
    const migrationFile = readdirSync(migrationsDir).find(
      (name) => name.startsWith('0040_') && name.endsWith('.sql')
    )
    expect(
      migrationFile,
      'expected a 0040 system_settings/key_rotated_at migration file to exist'
    ).toBeTruthy()

    const sql = readFileSync(resolve(migrationsDir, migrationFile as string), 'utf8')
    expect(sql).toMatch(/CREATE TABLE "system_settings"/)
    expect(sql).toMatch(/ADD COLUMN "key_rotated_at"/)
    // Backfill: existing vault_state rows get key_rotated_at = initialized_at, not NULL.
    expect(sql).toMatch(/UPDATE\s+"vault_state"\s+SET\s+"key_rotated_at"\s*=\s*"initialized_at"/i)
    // Never seeds a system_settings row — GET synthesizes defaults, table starts empty.
    expect(sql).not.toMatch(/INSERT INTO\s+"system_settings"/i)
    // vault_state's append-only trigger (0003_vault_state.sql) blocks the backfill UPDATE for
    // any *real* (non-empty) instance unless disabled/re-enabled around it — a migration is a
    // legitimate schema-level exception; a runtime app write must never get this bypass.
    expect(sql).toMatch(/ALTER TABLE "vault_state" DISABLE TRIGGER "vault_state_no_update"/)
    expect(sql).toMatch(/ALTER TABLE "vault_state" ENABLE TRIGGER "vault_state_no_update"/)
  })
})
