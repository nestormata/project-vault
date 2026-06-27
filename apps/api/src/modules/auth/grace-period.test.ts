import { describe, expect, it } from 'vitest'
import { setGracePeriodOnPrivilegedRole } from './grace-period.js'

describe('setGracePeriodOnPrivilegedRole', () => {
  const now = new Date('2026-06-27T12:00:00.000Z')

  it('sets a seven-day grace period for unenrolled owner and admin roles by default', () => {
    expect(
      setGracePeriodOnPrivilegedRole({
        role: 'owner',
        mfaEnrolledAt: null,
        now,
      })?.toISOString()
    ).toBe('2026-07-04T12:00:00.000Z')

    expect(
      setGracePeriodOnPrivilegedRole({
        role: 'admin',
        mfaEnrolledAt: null,
        now,
      })?.toISOString()
    ).toBe('2026-07-04T12:00:00.000Z')
  })

  it('does not set grace for enrolled or non-privileged users', () => {
    expect(
      setGracePeriodOnPrivilegedRole({
        role: 'owner',
        mfaEnrolledAt: now,
        now,
      })
    ).toBeNull()
    expect(setGracePeriodOnPrivilegedRole({ role: 'member', mfaEnrolledAt: null, now })).toBeNull()
    expect(setGracePeriodOnPrivilegedRole({ role: 'viewer', mfaEnrolledAt: null, now })).toBeNull()
  })

  it('does not extend an existing grace period', () => {
    const existingGracePeriodExpiresAt = new Date('2026-06-30T12:00:00.000Z')

    expect(
      setGracePeriodOnPrivilegedRole({
        role: 'owner',
        mfaEnrolledAt: null,
        existingGracePeriodExpiresAt,
        now,
      })
    ).toBe(existingGracePeriodExpiresAt)
  })

  it('supports zero-day grace for immediate enforcement', () => {
    expect(
      setGracePeriodOnPrivilegedRole({
        role: 'owner',
        mfaEnrolledAt: null,
        gracePeriodDays: 0,
        now,
      })?.toISOString()
    ).toBe(now.toISOString())
  })
})
