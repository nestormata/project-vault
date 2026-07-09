import { describe, expect, it, vi, beforeEach } from 'vitest'

const platformOperatorGateMock = vi.hoisted(() => vi.fn())
const fetchReadyMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/server/require-platform-operator.js', () => ({
  platformOperatorGate: platformOperatorGateMock,
}))

vi.mock('$lib/api/platform.js', () => ({
  fetchReady: fetchReadyMock,
}))

import { load } from './+page.server.js'

const platformUser = {
  userId: '00000000-0000-4000-8000-000000000001',
  orgId: '00000000-0000-4000-8000-000000000002',
  orgName: 'Test Org',
  sessionId: '00000000-0000-4000-8000-000000000003',
  orgRole: 'owner' as const,
  isPlatformOperator: true,
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

function makeEvent() {
  return { fetch: vi.fn(), locals: { user: platformUser } } as unknown as Parameters<typeof load>[0]
}

describe('/platform +page.server.ts', () => {
  beforeEach(() => {
    platformOperatorGateMock.mockReset()
    fetchReadyMock.mockReset()
  })

  it('AC-B1: returns allowed=false for a non-platform-operator without fetching ready', async () => {
    platformOperatorGateMock.mockReturnValue({ allowed: false })

    const result = await load(makeEvent())

    expect(result.allowed).toBe(false)
    expect(fetchReadyMock).not.toHaveBeenCalled()
  })

  it('AC-B1: returns allowed=true with empty warnings when GET /ready returns no warnings', async () => {
    platformOperatorGateMock.mockReturnValue({ allowed: true, user: platformUser })
    fetchReadyMock.mockResolvedValue({ status: 'ready' })

    const result = await load(makeEvent())

    expect(result.allowed).toBe(true)
    if (result.allowed) {
      expect(result.warnings).toEqual([])
    }
  })

  it('AC-B2: returns warnings list when GET /ready returns warnings', async () => {
    platformOperatorGateMock.mockReturnValue({ allowed: true, user: platformUser })
    fetchReadyMock.mockResolvedValue({ status: 'ready', warnings: ['key_custody_risk'] })

    const result = await load(makeEvent())

    expect(result.allowed).toBe(true)
    if (result.allowed) {
      expect(result.warnings).toContain('key_custody_risk')
    }
  })

  it('AC-B2 edge: returns empty warnings when GET /ready throws (fail open)', async () => {
    platformOperatorGateMock.mockReturnValue({ allowed: true, user: platformUser })
    fetchReadyMock.mockRejectedValue(new Error('Network error'))

    const result = await load(makeEvent())

    expect(result.allowed).toBe(true)
    if (result.allowed) {
      expect(result.warnings).toEqual([])
    }
  })
})
