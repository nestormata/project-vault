import { describe, expect, it } from 'vitest'
import {
  canSendTestNotification,
  filterRoutableAlertTypes,
  isRoutableAlertType,
} from './notification-settings-model.js'

describe('MFA alert types excluded from org routing UI (AC-6, ADR-3.4-06)', () => {
  it('marks MFA recovery alert types as non-routable', () => {
    expect(isRoutableAlertType('security.mfa_recovery_used')).toBe(false)
    expect(isRoutableAlertType('security.mfa_recovery_codes_regenerated')).toBe(false)
  })

  it('marks other alert types as routable', () => {
    expect(isRoutableAlertType('security.failed_auth_threshold')).toBe(true)
    expect(isRoutableAlertType('credential.expiry')).toBe(true)
  })

  it('filters MFA types out of a routing list while keeping everything else', () => {
    const routing = [
      { alertType: 'security.failed_auth_threshold', routeTo: 'owner' as const },
      { alertType: 'security.mfa_recovery_used', routeTo: 'owner' as const },
      { alertType: 'security.mfa_recovery_codes_regenerated', routeTo: 'owner' as const },
      { alertType: 'credential.expiry', routeTo: 'admin' as const },
    ]

    expect(filterRoutableAlertTypes(routing)).toEqual([
      { alertType: 'security.failed_auth_threshold', routeTo: 'owner' },
      { alertType: 'credential.expiry', routeTo: 'admin' },
    ])
  })
})

describe('send-test-notification admin+MFA guard (AC-5)', () => {
  it('allows owner/admin with MFA enrolled', () => {
    expect(canSendTestNotification({ orgRole: 'owner', mfaEnrolled: true })).toBe(true)
    expect(canSendTestNotification({ orgRole: 'admin', mfaEnrolled: true })).toBe(true)
  })

  it('denies members regardless of MFA status', () => {
    expect(canSendTestNotification({ orgRole: 'member', mfaEnrolled: true })).toBe(false)
  })

  it('denies admins who have not enrolled MFA', () => {
    expect(canSendTestNotification({ orgRole: 'admin', mfaEnrolled: false })).toBe(false)
  })
})
