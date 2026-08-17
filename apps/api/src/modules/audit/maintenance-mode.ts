import { AuditEvent } from '@project-vault/shared'

/**
 * Story 9.2 D10/AC-17: security-critical audit event types are NEVER suppressed by the audit-
 * storage maintenance-mode circuit breaker, even at 100% utilization — these are exactly the
 * events an operator most needs intact during a storage-pressure anomaly. Maintained as an
 * explicit allowlist (not a denylist) so any newly-added event type defaults to "suppressible"
 * only if a developer consciously omits it from this list, reviewed at PR time.
 */
export const SECURITY_CRITICAL_AUDIT_EVENT_TYPES: ReadonlySet<string> = new Set([
  AuditEvent.MFA_ENROLLMENT_STARTED,
  AuditEvent.MFA_ENROLLED,
  AuditEvent.MFA_LOGIN_VERIFIED,
  AuditEvent.MFA_RECOVERY_USED,
  AuditEvent.MFA_RECOVERY_CODES_REGENERATED,
  AuditEvent.SESSION_REVOKED,
  AuditEvent.LOGIN_FAILED,
  AuditEvent.ACCOUNT_RECOVERY_REQUESTED,
  AuditEvent.ACCOUNT_RECOVERY_LINK_SENT,
  AuditEvent.ACCOUNT_RECOVERY_COMPLETED,
  AuditEvent.ACCOUNT_RECOVERY_BLOCKED,
  AuditEvent.MACHINE_USER_API_KEY_ROTATED,
  AuditEvent.MACHINE_USER_API_KEY_EMERGENCY_REVOKED,
  // Code review (post-9.2 implementation): D10's own criterion — "any other event type already
  // written via a direct writeHumanAuditEntry/writeMachineAuditEntry/writeSystemAuditEntry call
  // rather than through the *OrFailClosed wrappers, are always written" — was not fully applied.
  // apps/api/src/modules/machine-users/rotation.ts writes this event via a direct
  // writeMachineAuditEntry() call when a rotated-out API key is reused (a potential credential-
  // compromise signal), the same class of event as MACHINE_USER_API_KEY_ROTATED/
  // _EMERGENCY_REVOKED above. Without this entry it would have been silently suppressed by the
  // maintenance-mode circuit breaker at exactly the moment (storage pressure) an anomaly like
  // this is most likely to also be occurring.
  AuditEvent.MACHINE_USER_ROTATION_ANOMALY_DETECTED,
])

export function isSecurityCriticalAuditEventType(eventType: string): boolean {
  return SECURITY_CRITICAL_AUDIT_EVENT_TYPES.has(eventType)
}

// Story 22.1 AC-10/AC-12: the instance-wide maintenance-mode write gate — `shouldSuppressAuditWrite`,
// `isAuditStorageMaintenanceModeActive` (as a write gate), and `logAuditWriteSuspended` — is
// DELETED, not narrowed. `audit_storage.critical` is now alert-only; the daily audit-storage/check
// job's alerting behaviour (apps/api/src/workers/audit-storage-check.ts) is left exactly as it
// was, but nothing anywhere reads that alert row to decide whether a write should be admitted. The
// replacement enforcement mechanism is per-organization: see
// apps/api/src/modules/audit/quota-gate.ts's assertOrgMayWriteAudit(). See D1/AC-12 for the full
// rationale (three jointly-fatal defects in the "keep it, make it universal and hard" fix that
// this deletion closes).
