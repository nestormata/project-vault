import { describe, expect, it, vi, beforeEach } from 'vitest'

const platformOperatorGateMock = vi.hoisted(() => vi.fn())
const getResourceUsageMock = vi.hoisted(() => vi.fn())
const fetchReadyMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/server/require-platform-operator.js', () => ({
  platformOperatorGate: platformOperatorGateMock,
}))

vi.mock('$lib/api/platform.js', () => ({
  getResourceUsage: getResourceUsageMock,
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

const SAMPLE_USAGE = {
  orgs: { current: 3, limit: 10 },
  usersPerOrg: [{ orgId: 'org-1', current: 5, limit: 50 }],
  secretsPerProject: [],
  auditLogEntries: { current: 1000, limit: null },
  storageBytes: { current: 900000, limit: null },
  auditLogStorage: { currentBytes: 42000000000, limitBytes: 50000000000, utilizationPct: 84 },
}

describe('/platform/settings/resource-usage +page.server.ts', () => {
  beforeEach(() => {
    platformOperatorGateMock.mockReset()
    getResourceUsageMock.mockReset()
    fetchReadyMock.mockReset()
  })

  it('AC-A3: returns allowed=false for non-platform-operator', async () => {
    platformOperatorGateMock.mockReturnValue({ allowed: false })

    const result = await load(makeEvent())

    expect(result.allowed).toBe(false)
    expect(getResourceUsageMock).not.toHaveBeenCalled()
  })

  it('AC-I1: returns resource usage for a platform operator', async () => {
    platformOperatorGateMock.mockReturnValue({ allowed: true, user: platformUser })
    getResourceUsageMock.mockResolvedValue(SAMPLE_USAGE)
    fetchReadyMock.mockResolvedValue({ status: 'ready' })

    const result = await load(makeEvent())

    expect(result.allowed).toBe(true)
    if (result.allowed) {
      expect(result.usage.orgs.current).toBe(3)
      expect(result.usage.auditLogStorage.utilizationPct).toBe(84)
    }
  })

  it('AC-I3: passes warnings from GET /ready', async () => {
    platformOperatorGateMock.mockReturnValue({ allowed: true, user: platformUser })
    getResourceUsageMock.mockResolvedValue(SAMPLE_USAGE)
    fetchReadyMock.mockResolvedValue({ status: 'ready', warnings: ['key_custody_risk'] })

    const result = await load(makeEvent())

    expect(result.allowed).toBe(true)
    if (result.allowed) {
      expect(result.warnings).toContain('key_custody_risk')
    }
  })
})
