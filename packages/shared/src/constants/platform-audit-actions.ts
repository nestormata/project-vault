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
  // Story 1.19 AC-6: GET /status bearer-token lifecycle mutations. Never the routine /status
  // probe traffic itself — that is counted via modules/status/metrics.ts, not audited here.
  STATUS_TOKEN_GENERATED: 'status_token.generated',
  STATUS_TOKEN_ROTATED: 'status_token.rotated',
  STATUS_TOKEN_REVOKED: 'status_token.revoked',
  // Story 23.2 AC-8a: the host-side operator:recovery-link break-glass CLI. Written on EVERY
  // invocation (minted or refused) as a single fail-closed write against the whole-instance,
  // non-RLS platform_audit_events table — deliberately NOT the per-org audit_log_entries
  // fanout that AC-8/AC-9's NATIVE_LOGIN_BREAK_GLASS_ACTIVE/NATIVE_LOGIN_DISABLED events use.
  // AC-8a item 4 requires a single strict fail-closed write ("if the audit write fails, the
  // command exits non-zero and prints nothing"); the sibling fanout is deliberately
  // best-effort per-org and swallows individual row failures, which would not satisfy that
  // contract. Reuses the identical string value as
  // AuditEvent.NATIVE_LOGIN_BREAK_GLASS_RECOVERY_MINTED for grep-ability across both registries.
  NATIVE_LOGIN_BREAK_GLASS_RECOVERY_MINTED: 'native_login.break_glass_recovery_minted',
} as const

export type PlatformAuditActionType = (typeof PlatformAuditAction)[keyof typeof PlatformAuditAction]
