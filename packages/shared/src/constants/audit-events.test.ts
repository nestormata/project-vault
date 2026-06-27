import { describe, expect, it } from 'vitest'
import { AuditEvent } from './audit-events.js'

describe('AuditEvent', () => {
  it('exposes Story 1.6 authentication audit event constants', () => {
    expect(AuditEvent.USER_REGISTERED).toBe('USER_REGISTERED')
    expect(AuditEvent.SESSION_CREATED).toBe('SESSION_CREATED')
    expect(AuditEvent.SESSION_REVOKED).toBe('SESSION_REVOKED')
    expect(AuditEvent.LOGIN_FAILED).toBe('LOGIN_FAILED')
  })
})
