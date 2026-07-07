import { and, eq } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import { adminAlerts } from '@project-vault/db/schema'
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
])

export function isSecurityCriticalAuditEventType(eventType: string): boolean {
  return SECURITY_CRITICAL_AUDIT_EVENT_TYPES.has(eventType)
}

/** AC-17/D5: the daily audit-storage:check job's `admin_alerts` row for `audit_storage.critical`
 * IS the maintenance-mode flag — an active row means maintenance mode is on; the same job
 * acknowledges it once utilization drops back below 95% (AC-17's "resuming normal operation"
 * case), which is also what turns maintenance mode back off. No separate state table needed. */
export async function isAuditStorageMaintenanceModeActive(tx: Tx): Promise<boolean> {
  const [row] = await tx
    .select({ id: adminAlerts.id })
    .from(adminAlerts)
    .where(
      and(eq(adminAlerts.alertType, 'audit_storage.critical'), eq(adminAlerts.status, 'active'))
    )
    .limit(1)
  return Boolean(row)
}

/**
 * AC-17: called by writeHumanAuditEntry/writeMachineAuditEntry/writeSystemAuditEntry immediately
 * before the INSERT. Returns true (write must be skipped) only for non-allowlisted event types
 * while maintenance mode is active — event-type membership is checked FIRST, before the storage-
 * pressure lookup, so a security-critical write never even queries maintenance-mode state.
 */
export async function shouldSuppressAuditWrite(tx: Tx, eventType: string): Promise<boolean> {
  if (isSecurityCriticalAuditEventType(eventType)) return false
  return isAuditStorageMaintenanceModeActive(tx)
}

/** AC-17: structured WARN-level operational log for a suppressed write — emitted via direct
 * stdout write (same discipline as notifications/routing.ts's routing-fallback logging) since
 * the audit write-entry functions have no FastifyBaseLogger reference to thread through every
 * call site across the codebase. */
export function logAuditWriteSuspended(eventType: string, orgId: string): void {
  process.stdout.write(
    `${JSON.stringify({
      event: 'audit.write_suspended',
      level: 'warn',
      eventType,
      orgId,
      reason: 'audit_storage_maintenance_mode',
    })}\n`
  )
}
