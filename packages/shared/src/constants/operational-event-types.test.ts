import { describe, expect, it } from 'vitest'
import { OperationalEvent, SYSTEM_TRACE_ID } from './operational-event-types.js'

describe('OperationalEvent', () => {
  it('exposes the SYSTEM_TRACE_ID sentinel for non-request logs', () => {
    expect(SYSTEM_TRACE_ID).toBe('system')
  })

  it('uses domain.action dot notation for every event type value', () => {
    for (const value of Object.values(OperationalEvent)) {
      expect(value).toMatch(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/)
    }
  })

  it('exposes the Story 1.10 core registry entries', () => {
    expect(OperationalEvent.HTTP_REQUEST).toBe('http.request')
    expect(OperationalEvent.STARTUP_COMPLETE).toBe('startup.complete')
    expect(OperationalEvent.JOB_STARTED).toBe('job.started')
    expect(OperationalEvent.JOB_COMPLETED).toBe('job.completed')
    expect(OperationalEvent.JOB_FAILED).toBe('job.failed')
    expect(OperationalEvent.DB_ERROR).toBe('db.error')
  })

  it('exposes the migrated vault eventType values', () => {
    expect(OperationalEvent.VAULT_INIT).toBe('vault.init')
    expect(OperationalEvent.VAULT_UNSEAL).toBe('vault.unseal')
  })

  it('exposes registry entries for Story 1.7-1.9 event types', () => {
    expect(OperationalEvent.ALERT_PENDING_EPIC3).toBe('alert.pending_epic3')
    expect(OperationalEvent.SECURITY_FAILED_AUTH_THRESHOLD_NO_ORG).toBe(
      'security.failed_auth_threshold_no_org'
    )
    expect(OperationalEvent.SECURITY_MFA_ENROLLMENT_REQUIRED_DENIED).toBe(
      'security.mfa_enrollment_required_denied'
    )
  })
})
