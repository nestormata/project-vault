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

  it('exposes Story 2.2 credential audit event names and retires the stale secret.* vocabulary', () => {
    expect(AuditEvent.CREDENTIAL_CREATED).toBe('credential.created')
    expect(AuditEvent.CREDENTIAL_VERSION_CREATED).toBe('credential.version_created')
    expect(AuditEvent.CREDENTIAL_VALUE_REVEALED).toBe('credential.value_revealed')
    expect(AuditEvent.CREDENTIAL_VERSION_PURGED).toBe('credential.version_purged')
    expect(Object.values(AuditEvent)).not.toEqual(
      expect.arrayContaining(['secret.created', 'secret.read', 'secret.updated', 'secret.deleted'])
    )
  })

  it('exposes Story 2.3 tag audit event names', () => {
    expect(AuditEvent.CREDENTIAL_TAGS_UPDATED).toBe('credential.tags_updated')
    expect(AuditEvent.PROJECT_TAGS_UPDATED).toBe('project.tags_updated')
  })

  it('exposes Story 5.1 rotation audit event name', () => {
    expect(AuditEvent.ROTATION_INITIATED).toBe('rotation.initiated')
  })

  it('exposes Story 5.2 rotation checklist/completion audit event names', () => {
    expect(AuditEvent.ROTATION_CHECKLIST_ITEM_CONFIRMED).toBe('rotation.checklist_item_confirmed')
    expect(AuditEvent.ROTATION_CHECKLIST_ITEM_FAILED).toBe('rotation.checklist_item_failed')
    expect(AuditEvent.ROTATION_CHECKLIST_ITEM_RETRIED).toBe('rotation.checklist_item_retried')
    expect(AuditEvent.ROTATION_CHECKLIST_ITEM_MAX_RETRIES_EXCEEDED).toBe(
      'rotation.checklist_item_max_retries_exceeded'
    )
    expect(AuditEvent.ROTATION_COMPLETED).toBe('rotation.completed')
  })

  it('exposes Story 5.3 break-glass/stale-recovery rotation audit event names', () => {
    expect(AuditEvent.ROTATION_BREAK_GLASS_INITIATED).toBe('rotation.break_glass_initiated')
    expect(AuditEvent.ROTATION_SUPERSEDED_BY_BREAK_GLASS).toBe('rotation.superseded_by_break_glass')
    expect(AuditEvent.ROTATION_BREAK_GLASS_OVERLAP_EXPIRED).toBe(
      'rotation.break_glass_overlap_expired'
    )
    expect(AuditEvent.ROTATION_STALE_DETECTED).toBe('rotation.stale_detected')
    expect(AuditEvent.ROTATION_RESUMED).toBe('rotation.resumed')
    expect(AuditEvent.ROTATION_ABANDONED).toBe('rotation.abandoned')
  })

  it('exposes Story 6.1 payment/certificate/domain record audit event names', () => {
    expect(AuditEvent.PAYMENT_RECORD_CREATED).toBe('payment_record.created')
    expect(AuditEvent.PAYMENT_RECORD_UPDATED).toBe('payment_record.updated')
    expect(AuditEvent.PAYMENT_RECORD_DELETED).toBe('payment_record.deleted')
    expect(AuditEvent.CERTIFICATE_CREATED).toBe('certificate.created')
    expect(AuditEvent.CERTIFICATE_UPDATED).toBe('certificate.updated')
    expect(AuditEvent.CERTIFICATE_DELETED).toBe('certificate.deleted')
    expect(AuditEvent.DOMAIN_RECORD_CREATED).toBe('domain_record.created')
    expect(AuditEvent.DOMAIN_RECORD_UPDATED).toBe('domain_record.updated')
    expect(AuditEvent.DOMAIN_RECORD_DELETED).toBe('domain_record.deleted')
  })

  it('exposes Story 6.2 service-endpoint/monitoring-alert/security-alert audit event names', () => {
    expect(AuditEvent.SERVICE_ENDPOINT_CREATED).toBe('service_endpoint.created')
    expect(AuditEvent.SERVICE_ENDPOINT_UPDATED).toBe('service_endpoint.updated')
    expect(AuditEvent.SERVICE_ENDPOINT_DELETED).toBe('service_endpoint.deleted')
    expect(AuditEvent.MONITORING_ALERT_SNOOZED).toBe('monitoring_alert.snoozed')
    expect(AuditEvent.MONITORING_ALERT_DISMISSED).toBe('monitoring_alert.dismissed')
    expect(AuditEvent.SECURITY_ALERT_DISMISSED).toBe('security_alert.dismissed')
  })

  it('exposes Story 7.1 machine-user audit event names (D7)', () => {
    expect(AuditEvent.MACHINE_USER_CREATED).toBe('machine_user.created')
    expect(AuditEvent.MACHINE_USER_API_KEY_ISSUED).toBe('machine_user.api_key_issued')
    expect(AuditEvent.MACHINE_USER_API_KEY_REVOKED).toBe('machine_user.api_key_revoked')
  })

  it('exposes Story 7.2 rotation/dormancy audit event names (Task 13)', () => {
    expect(AuditEvent.MACHINE_USER_API_KEY_ROTATED).toBe('machine_user.api_key_rotated')
    expect(AuditEvent.MACHINE_USER_API_KEY_EMERGENCY_REVOKED).toBe(
      'machine_user.api_key_emergency_revoked'
    )
    expect(AuditEvent.MACHINE_USER_ROTATION_ANOMALY_DETECTED).toBe(
      'machine_user.rotation_anomaly_detected'
    )
    expect(AuditEvent.MACHINE_USER_DORMANCY_EXTENDED).toBe('machine_user.dormancy_extended')
  })

  it('exposes Story 7.2 cache-activation beacon audit event name (D13/AC-15)', () => {
    expect(AuditEvent.MACHINE_CACHE_ACTIVATED).toBe('machine_cache.activated')
  })
})
