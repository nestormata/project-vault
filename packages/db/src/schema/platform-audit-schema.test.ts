import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  platformAuditEvents,
  platformAuditMaintenanceState,
  platformAuditPendingEntries,
  vaultState,
} from './index.js'
import { EXCLUDED_TABLES } from '../check-rls-coverage.js'

describe('Story 9.4 platform-audit schema (AC-1, AC-5, AC-22)', () => {
  it('exposes platform_audit_events columns (AC-1)', () => {
    expect(platformAuditEvents.id).toBeDefined()
    expect(platformAuditEvents.operatorId).toBeDefined()
    expect(platformAuditEvents.actionType).toBeDefined()
    expect(platformAuditEvents.targetOrgId).toBeDefined()
    expect(platformAuditEvents.targetUserId).toBeDefined()
    expect(platformAuditEvents.payload).toBeDefined()
    expect(platformAuditEvents.ipAddress).toBeDefined()
    expect(platformAuditEvents.keyVersion).toBeDefined()
    expect(platformAuditEvents.hmac).toBeDefined()
    expect(platformAuditEvents.createdAt).toBeDefined()
    expect((platformAuditEvents as unknown as { updatedAt?: unknown }).updatedAt).toBeUndefined()
  })

  it('exposes platform_audit_maintenance_state columns (D8)', () => {
    expect(platformAuditMaintenanceState.id).toBeDefined()
    expect(platformAuditMaintenanceState.active).toBeDefined()
    expect(platformAuditMaintenanceState.reason).toBeDefined()
    expect(platformAuditMaintenanceState.activatedByUserId).toBeDefined()
    expect(platformAuditMaintenanceState.activatedAt).toBeDefined()
    expect(platformAuditMaintenanceState.deactivatedAt).toBeDefined()
  })

  it('exposes platform_audit_pending_entries columns (D8)', () => {
    expect(platformAuditPendingEntries.id).toBeDefined()
    expect(platformAuditPendingEntries.intendedFields).toBeDefined()
    expect(platformAuditPendingEntries.attemptedAt).toBeDefined()
    expect(platformAuditPendingEntries.sequenceNum).toBeDefined()
  })

  it('exposes vault_state.platform_audit_key_version, independent of audit_key_version (AC-5)', () => {
    expect(vaultState.platformAuditKeyVersion).toBeDefined()
    expect(vaultState.auditKeyVersion).toBeDefined()
  })

  it('documents all three new tables as RLS coverage exceptions (D4, AC-22)', () => {
    expect(EXCLUDED_TABLES.has('platform_audit_events')).toBe(true)
    expect(EXCLUDED_TABLES.has('platform_audit_maintenance_state')).toBe(true)
    expect(EXCLUDED_TABLES.has('platform_audit_pending_entries')).toBe(true)
  })

  it('migration 0041 is additive-only: no UPDATE/DELETE against pre-existing tables other than the vault_state column ADD (AC-22)', () => {
    const migrationPath = resolve(
      import.meta.dirname,
      '../migrations/0041_platform_audit_events.sql'
    )
    const sql = readFileSync(migrationPath, 'utf8')
    const sqlWithoutComments = sql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
    // The only non-CREATE-table statement that touches an existing row is the maintenance-state
    // bootstrap INSERT (a brand-new table, id=1) and the vault_state ADD COLUMN — neither is an
    // UPDATE/DELETE against pre-existing data.
    expect(sqlWithoutComments).not.toMatch(/\bDELETE\s+FROM\b/i)
    expect(sqlWithoutComments).not.toMatch(/UPDATE\s+"?vault_state"?\s+SET/i)
    expect(sqlWithoutComments).not.toMatch(/UPDATE\s+"?users"?\s+SET/i)
  })
})
