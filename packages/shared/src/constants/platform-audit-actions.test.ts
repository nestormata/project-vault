import { describe, expect, it } from 'vitest'
import { PlatformAuditAction } from './platform-audit-actions.js'
import type { PlatformAuditActionType } from './platform-audit-actions.js'

function assertValidPlatformAuditActionType(
  value: PlatformAuditActionType
): PlatformAuditActionType {
  return value
}

describe('Story 9.4 D7/D8/AC-11: PlatformAuditAction', () => {
  it('exposes the D7 retrofit action types (9.1/9.2 route handlers)', () => {
    expect(PlatformAuditAction.BACKUP_TRIGGERED).toBe('backup.triggered')
    expect(PlatformAuditAction.BACKUP_RESTORE_INITIATED).toBe('backup.restore_initiated')
    expect(PlatformAuditAction.BACKUP_RESTORE_COMPLETED).toBe('backup.restore_completed')
    expect(PlatformAuditAction.BACKUP_RESTORE_FAILED).toBe('backup.restore_failed')
    expect(PlatformAuditAction.BACKUP_VALIDATED).toBe('backup.validated')
    expect(PlatformAuditAction.SETTINGS_UPDATED).toBe('settings.updated')
    expect(PlatformAuditAction.ORG_CREATED).toBe('org.created')
  })

  it('exposes the AC-11 self-audit action type for GET /platform/audit/verify', () => {
    expect(PlatformAuditAction.INTEGRITY_VERIFY_RUN).toBe('platform_audit.integrity_verify_run')
  })

  it('exposes the D8 maintenance-mode action types', () => {
    expect(PlatformAuditAction.MAINTENANCE_MODE_ACTIVATED).toBe('maintenance_mode.activated')
    expect(PlatformAuditAction.MAINTENANCE_MODE_DEACTIVATED).toBe('maintenance_mode.deactivated')
  })

  it('derives PlatformAuditActionType from every current PlatformAuditAction value', () => {
    for (const value of Object.values(PlatformAuditAction)) {
      expect(assertValidPlatformAuditActionType(value)).toBe(value)
    }
  })
})
