import { describe, expect, it } from 'vitest'
import { AuditEvent } from '@project-vault/shared'

const { isSecurityCriticalAuditEventType } = await import('./maintenance-mode.js')

const ROUTINE_EVENT_TYPE = 'credential.value_revealed'

describe('Story 9.2 D10 / Story 22.1 AC-12: SECURITY_CRITICAL_AUDIT_EVENT_TYPES survives the deletion of the instance-wide write gate', () => {
  it('AC-17: security-critical event types are never in the suppressible set', () => {
    expect(isSecurityCriticalAuditEventType(AuditEvent.MFA_RECOVERY_USED)).toBe(true)
    expect(isSecurityCriticalAuditEventType(AuditEvent.MACHINE_USER_API_KEY_ROTATED)).toBe(true)
    expect(isSecurityCriticalAuditEventType(ROUTINE_EVENT_TYPE)).toBe(false)
  })

  it('AC-17/D10 code-review regression: machine-key rotation-anomaly detection (written via a direct writeMachineAuditEntry call in rotation.ts) is security-critical', () => {
    expect(
      isSecurityCriticalAuditEventType(AuditEvent.MACHINE_USER_ROTATION_ANOMALY_DETECTED)
    ).toBe(true)
  })

  // Story 22.1 AC-10/AC-12: `shouldSuppressAuditWrite`, `isAuditStorageMaintenanceModeActive` (as
  // a write gate), and `logAuditWriteSuspended` are DELETED, not narrowed — there is no longer any
  // "skip this write" code path in this module. That behaviour (a routine write now succeeds and
  // is recorded regardless of instance-wide utilization) is covered by
  // apps/api/src/workers/audit-storage-check.test.ts's "resumes normal operation" case and by
  // apps/api/src/modules/audit/quota-gate.test.ts's cross-org isolation tests.
  it('AC-10: no suppression predicate exists on this module any more', async () => {
    const moduleExports = await import('./maintenance-mode.js')
    expect('shouldSuppressAuditWrite' in moduleExports).toBe(false)
    expect('isAuditStorageMaintenanceModeActive' in moduleExports).toBe(false)
    expect('logAuditWriteSuspended' in moduleExports).toBe(false)
  })
})
