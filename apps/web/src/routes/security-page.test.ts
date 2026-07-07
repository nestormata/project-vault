import { describe, expect, it, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/svelte'
import { routeExists } from '$lib/test/route-exists.js'
import type { AuthUser } from '$lib/api/auth.js'

vi.mock('$lib/api/auth.js', () => ({
  enrollMfa: vi.fn(),
  verifyMfaEnrollment: vi.fn(),
  regenerateMfaRecoveryCodes: vi.fn(),
}))

import SecurityPage from './(app)/settings/security/+page.svelte'

function baseUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    userId: 'u1',
    orgId: 'o1',
    sessionId: 's1',
    orgRole: 'owner',
    mfaEnrolled: false,
    mfaEnrolledAt: null,
    remainingRecoveryCodesCount: null,
    mfaStatus: {
      enrollmentRequired: false,
      gracePeriodActive: false,
      gracePeriodExpiresAt: null,
      gracePeriodDaysRemaining: null,
      bannerMessage: null,
    },
    ...overrides,
  }
}

describe('/settings/security +page.svelte', () => {
  afterEach(() => cleanup())

  it('is a real, existing route (regression guard for the five previously-broken /settings/security links)', () => {
    expect(routeExists('/settings/security')).toBe(true)
  })

  it('renders the MFA enrollment call to action for an unenrolled user', () => {
    render(SecurityPage, { props: { data: { user: baseUser() } } })

    expect(screen.getByRole('heading', { name: 'Security' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /set up authenticator app/i })).toBeTruthy()
  })

  it('renders the enabled status for an already-enrolled user', () => {
    render(SecurityPage, {
      props: {
        data: {
          user: baseUser({
            mfaEnrolled: true,
            mfaEnrolledAt: '2026-06-01T00:00:00.000Z',
            remainingRecoveryCodesCount: 5,
          }),
        },
      },
    })

    expect(screen.getByText(/mfa is enabled/i)).toBeTruthy()
  })

  it('links back to the settings hub', () => {
    render(SecurityPage, { props: { data: { user: baseUser() } } })

    const link = screen.getByRole('link', { name: /settings/i })
    expect(link.getAttribute('href')).toBe('/settings')
  })
})
