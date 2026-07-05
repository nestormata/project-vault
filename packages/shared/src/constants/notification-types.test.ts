import { describe, expect, it } from 'vitest'
import { NOTIFICATION_ALERT_TYPES } from './notification-types.js'

describe('MFA alert types in shared registry (AC-6)', () => {
  it('registers the canonical MFA recovery alert type IDs', () => {
    expect(NOTIFICATION_ALERT_TYPES).toContain('security.mfa_recovery_used')
    expect(NOTIFICATION_ALERT_TYPES).toContain('security.mfa_recovery_codes_regenerated')
  })
})

describe('Story 5.2 rotation checklist alert types', () => {
  it('registers the confirmation-failed and max-retries-exceeded alert type IDs', () => {
    expect(NOTIFICATION_ALERT_TYPES).toContain('rotation.confirmation_failed')
    expect(NOTIFICATION_ALERT_TYPES).toContain('rotation.max_retries_exceeded')
  })
})

describe('Story 6.1 operational monitoring alert types', () => {
  it('registers payment/certificate/domain expiry alert type IDs', () => {
    expect(NOTIFICATION_ALERT_TYPES).toContain('payment.expiry')
    expect(NOTIFICATION_ALERT_TYPES).toContain('certificate.expiry')
    expect(NOTIFICATION_ALERT_TYPES).toContain('domain.expiry')
  })
})

describe('Story 6.2 HTTP endpoint monitoring alert types (ADR-6.2-02)', () => {
  it('already registers service.down/service.recovery/security.anomalous_access verbatim', () => {
    expect(NOTIFICATION_ALERT_TYPES).toContain('service.down')
    expect(NOTIFICATION_ALERT_TYPES).toContain('service.recovery')
    expect(NOTIFICATION_ALERT_TYPES).toContain('security.anomalous_access')
  })

  it('does NOT register the misspelled epics.md prose variant "service.recovered"', () => {
    expect(NOTIFICATION_ALERT_TYPES).not.toContain('service.recovered')
  })
})

describe('Story 7.2 machine-key dormancy alert type (D9/AC-21, Task 14)', () => {
  it('registers the machine_key.dormant alert type ID', () => {
    expect(NOTIFICATION_ALERT_TYPES).toContain('machine_key.dormant')
  })
})
