import { describe, expect, it, vi, beforeEach } from 'vitest'

const platformOperatorGateMock = vi.hoisted(() => vi.fn())
const listOrgsMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/server/require-platform-operator.js', () => ({
  platformOperatorGate: platformOperatorGateMock,
}))

vi.mock('$lib/api/platform.js', () => ({
  listOrgs: listOrgsMock,
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

describe('/platform/settings/orgs +page.server.ts', () => {
  beforeEach(() => {
    platformOperatorGateMock.mockReset()
    listOrgsMock.mockReset()
  })

  it('AC-A3: returns allowed=false for non-platform-operator without fetching orgs', async () => {
    platformOperatorGateMock.mockReturnValue({ allowed: false })

    const result = await load(makeEvent())

    expect(result.allowed).toBe(false)
    expect(listOrgsMock).not.toHaveBeenCalled()
  })

  it('AC-H1: returns allowed=true with orgs list for a platform operator', async () => {
    platformOperatorGateMock.mockReturnValue({ allowed: true, user: platformUser })
    listOrgsMock.mockResolvedValue({
      items: [
        {
          id: 'org-1',
          name: 'Test Org',
          slug: 'test-org',
          createdAt: '2026-01-01T00:00:00Z',
          memberCount: 1,
        },
      ],
    })

    const result = await load(makeEvent())

    expect(result.allowed).toBe(true)
    if (result.allowed) {
      expect(result.orgs).toHaveLength(1)
      expect(result.orgs[0].name).toBe('Test Org')
    }
  })

  it('surfaces errorMessage on API failure without crashing', async () => {
    platformOperatorGateMock.mockReturnValue({ allowed: true, user: platformUser })
    listOrgsMock.mockRejectedValue(new Error('Network error'))

    const result = await load(makeEvent())

    expect(result.allowed).toBe(true)
    if (result.allowed) {
      expect(result.orgs).toHaveLength(0)
      expect(result.errorMessage).toBeTruthy()
    }
  })
})
