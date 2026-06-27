import { describe, expect, it } from 'vitest'
import { computeMfaStatus, isMfaEnforcementActive } from './mfa-enforcement.js'

describe('isMfaEnforcementActive', () => {
  const now = new Date('2026-06-27T12:00:00.000Z')

  it('requires MFA for unenrolled owner/admin after grace expires or when grace is missing', () => {
    expect(isMfaEnforcementActive('owner', null, new Date('2026-06-27T11:59:00.000Z'), now)).toBe(
      true
    )
    expect(isMfaEnforcementActive('admin', null, null, now)).toBe(true)
  })

  it('does not require MFA for enrolled, non-privileged, or still-in-grace users', () => {
    expect(isMfaEnforcementActive('owner', now, null, now)).toBe(false)
    expect(isMfaEnforcementActive('member', null, null, now)).toBe(false)
    expect(isMfaEnforcementActive('viewer', null, null, now)).toBe(false)
    expect(isMfaEnforcementActive('owner', null, new Date('2026-06-28T12:00:00.000Z'), now)).toBe(
      false
    )
  })
})

describe('computeMfaStatus', () => {
  const now = new Date('2026-06-27T12:00:00.000Z')
  const graceExpiresInThreeDays = new Date('2026-06-30T01:00:00.000Z')

  it('returns grace banner metadata while privileged user is in grace', () => {
    const status = computeMfaStatus({
      orgRole: 'owner',
      mfaEnrolledAt: null,
      gracePeriodExpiresAt: graceExpiresInThreeDays,
      now,
    })

    expect(status).toEqual({
      mfaEnrolled: false,
      mfaStatus: {
        enrollmentRequired: false,
        gracePeriodActive: true,
        gracePeriodExpiresAt: graceExpiresInThreeDays.toISOString(),
        gracePeriodDaysRemaining: 3,
        bannerMessage:
          'MFA enrollment is required for Owner and Admin roles within 3 days. Enroll at /settings/security.',
      },
    })
  })

  it('returns required banner metadata after grace expires', () => {
    const status = computeMfaStatus({
      orgRole: 'admin',
      mfaEnrolledAt: null,
      gracePeriodExpiresAt: new Date('2026-06-26T12:00:00.000Z'),
      now,
    })

    expect(status).toEqual({
      mfaEnrolled: false,
      mfaStatus: {
        enrollmentRequired: true,
        gracePeriodActive: false,
        gracePeriodExpiresAt: null,
        gracePeriodDaysRemaining: null,
        bannerMessage:
          'MFA enrollment is required for Owner and Admin roles. Enroll at /settings/security.',
      },
    })
  })

  it('returns a quiet status when MFA is already enrolled', () => {
    expect(
      computeMfaStatus({
        orgRole: 'owner',
        mfaEnrolledAt: now,
        gracePeriodExpiresAt: graceExpiresInThreeDays,
        now,
      })
    ).toEqual({
      mfaEnrolled: true,
      mfaStatus: {
        enrollmentRequired: false,
        gracePeriodActive: false,
        gracePeriodExpiresAt: null,
        gracePeriodDaysRemaining: null,
        bannerMessage: null,
      },
    })
  })
})
