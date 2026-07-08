/**
 * Story 9.4 D7/D8/AC-11: the full `actionType` registry written into `platform_audit_events`.
 * Single source of truth — route handlers and the retrofitted 9.1/9.2 route files must use these
 * constants rather than repeating the literal strings.
 */
export const PlatformAuditAction = {
  // D7: retrofitted into Story 9.1's backup/restore route handlers.
  BACKUP_TRIGGERED: 'backup.triggered',
  BACKUP_RESTORE_INITIATED: 'backup.restore_initiated',
  BACKUP_RESTORE_COMPLETED: 'backup.restore_completed',
  BACKUP_RESTORE_FAILED: 'backup.restore_failed',
  BACKUP_VALIDATED: 'backup.validated',
  // D7: retrofitted into Story 9.2's settings/org-creation route handlers.
  SETTINGS_UPDATED: 'settings.updated',
  ORG_CREATED: 'org.created',
  // AC-11: GET /platform/audit/verify's own self-audit row (mirrors the org-scoped
  // audit.integrity_verify_run precedent).
  INTEGRITY_VERIFY_RUN: 'platform_audit.integrity_verify_run',
  // D8: maintenance-mode activation/deactivation.
  MAINTENANCE_MODE_ACTIVATED: 'maintenance_mode.activated',
  MAINTENANCE_MODE_DEACTIVATED: 'maintenance_mode.deactivated',
} as const

export type PlatformAuditActionType = (typeof PlatformAuditAction)[keyof typeof PlatformAuditAction]
