import { describe, expect, it } from 'vitest'
import { AuditEvent } from './audit-events.js'

describe('AuditEvent', () => {
  it('exposes Story 1.6 authentication audit event constants', () => {
    expect(AuditEvent.USER_REGISTERED).toBe('USER_REGISTERED')
    expect(AuditEvent.SESSION_CREATED).toBe('SESSION_CREATED')
    expect(AuditEvent.SESSION_REVOKED).toBe('SESSION_REVOKED')
    expect(AuditEvent.LOGIN_FAILED).toBe('LOGIN_FAILED')
  })

  it('exposes Story 1.8 MFA audit event constants', () => {
    expect(AuditEvent.MFA_ENROLLMENT_STARTED).toBe('MFA_ENROLLMENT_STARTED')
    expect(AuditEvent.MFA_ENROLLED).toBe('MFA_ENROLLED')
    expect(AuditEvent.MFA_RECOVERY_USED).toBe('MFA_RECOVERY_USED')
    expect(AuditEvent.MFA_RECOVERY_CODES_REGENERATED).toBe('MFA_RECOVERY_CODES_REGENERATED')
  })

  it('exposes Story 1.9 failed auth threshold audit event constant', () => {
    expect(AuditEvent.SECURITY_FAILED_AUTH_THRESHOLD).toBe('security.failed_auth_threshold')
  })

  it('exposes Story 1.12 MFA login audit event constants', () => {
    expect(AuditEvent.MFA_LOGIN_VERIFIED).toBe('MFA_LOGIN_VERIFIED')
    expect(Object.values(AuditEvent)).not.toContain('MFA_LOGIN_CHALLENGED')
  })

  it('exposes Story 2.1 project audit event names', () => {
    expect(AuditEvent.PROJECT_CREATED).toBe('project.created')
    expect(AuditEvent.PROJECT_UPDATED).toBe('project.updated')
  })
})
