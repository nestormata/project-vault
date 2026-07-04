import { describe, expect, it } from 'vitest'
import { OperationalEvent, SYSTEM_TRACE_ID } from './operational-event-types.js'

describe('OperationalEvent', () => {
  it('exposes the SYSTEM_TRACE_ID sentinel for non-request logs', () => {
    expect(SYSTEM_TRACE_ID).toBe('system')
  })

  it('uses domain.action dot notation for every event type value', () => {
    for (const value of Object.values(OperationalEvent)) {
      const segments = value.split('.')
      expect(segments.length).toBeGreaterThanOrEqual(2)
      expect(
        segments.every((segment) => segment.length > 0 && segment === segment.toLowerCase())
      ).toBe(true)
      expect(segments.every((segment) => /^[a-z0-9_]+$/.test(segment))).toBe(true)
      expect(segments[0]?.[0]).toMatch(/[a-z]/)
    }
  })

  it('exposes the Story 1.10 core registry entries', () => {
    expect(OperationalEvent.HTTP_REQUEST).toBe('http.request')
    expect(OperationalEvent.STARTUP_COMPLETE).toBe('startup.complete')
    expect(OperationalEvent.STARTUP_FAILED).toBe('startup.failed')
    expect(OperationalEvent.SHUTDOWN_FAILED).toBe('shutdown.failed')
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

  it('exposes the Story 6.1 monitoring expiry-alert row-failure event type', () => {
    expect(OperationalEvent.MONITORING_EXPIRY_ALERT_ROW_FAILED).toBe(
      'monitoring.expiry_alert_row_failed'
    )
  })

  it('exposes the Story 6.2 health-check scheduler/row event types', () => {
    expect(OperationalEvent.MONITORING_HEALTH_CHECK_TICK_SKIPPED_OVERLAP).toBe(
      'monitoring.health_check_tick_skipped_overlap'
    )
    expect(OperationalEvent.MONITORING_HEALTH_CHECK_ROW_FAILED).toBe(
      'monitoring.health_check_row_failed'
    )
  })
})
