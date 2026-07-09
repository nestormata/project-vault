import { describe, expect, it, vi } from 'vitest'

vi.mock('@sveltejs/kit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sveltejs/kit')>()
  return { ...actual, redirect: (status: number, location: string) => ({ status, location }) }
})

import { platformOperatorGate } from './require-platform-operator.js'

const baseUser = {
  userId: '00000000-0000-4000-8000-000000000001',
  orgId: '00000000-0000-4000-8000-000000000002',
  orgName: 'Test Org',
  sessionId: '00000000-0000-4000-8000-000000000003',
  orgRole: 'owner' as const,
  isPlatformOperator: false,
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
}

describe('platformOperatorGate', () => {
  it('AC-A3: returns { allowed: true, user } for a platform operator', () => {
    const user = { ...baseUser, isPlatformOperator: true }
    const result = platformOperatorGate({ user })
    expect(result).toEqual({ allowed: true, user })
  })

  it('AC-A3: returns { allowed: false } for a non-platform-operator', () => {
    const user = { ...baseUser, isPlatformOperator: false }
    const result = platformOperatorGate({ user })
    expect(result).toEqual({ allowed: false })
  })

  it('redirects to /login when no user is in locals (unauthenticated)', () => {
    expect(() => platformOperatorGate({ user: null })).toThrow()
  })
})
