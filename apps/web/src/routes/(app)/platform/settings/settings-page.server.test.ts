import { describe, expect, it, vi, beforeEach } from 'vitest'

const platformOperatorGateMock = vi.hoisted(() => vi.fn())
const getSettingsMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/server/require-platform-operator.js', () => ({
  platformOperatorGate: platformOperatorGateMock,
}))

vi.mock('$lib/api/platform.js', () => ({
  getSettings: getSettingsMock,
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

const SAMPLE_SETTINGS = {
  smtp: {
    host: 'smtp.example.com',
    port: 587,
    user: 'noreply',
    from: 'noreply@example.com',
    configured: true,
  },
  backup: { schedule: '0 3 * * *', retentionCount: 7, storageType: 'filesystem' as const },
  notifications: { defaultSlackWebhook: null },
  instancePolicy: { maxOrgs: 10, maxUsersPerOrg: 50, sessionIdleTimeoutMinutes: 30 },
}

describe('/platform/settings +page.server.ts', () => {
  beforeEach(() => {
    platformOperatorGateMock.mockReset()
    getSettingsMock.mockReset()
  })

  it('AC-A3: returns allowed=false for non-platform-operator without fetching settings', async () => {
    platformOperatorGateMock.mockReturnValue({ allowed: false })

    const result = await load(makeEvent())

    expect(result.allowed).toBe(false)
    expect(getSettingsMock).not.toHaveBeenCalled()
  })

  it('AC-G1: returns allowed=true with current settings for a platform operator', async () => {
    platformOperatorGateMock.mockReturnValue({ allowed: true, user: platformUser })
    getSettingsMock.mockResolvedValue(SAMPLE_SETTINGS)

    const result = await load(makeEvent())

    expect(result.allowed).toBe(true)
    if (result.allowed) {
      expect(result.settings.smtp.host).toBe('smtp.example.com')
      expect(result.settings.smtp.configured).toBe(true)
      expect(result.settings.instancePolicy.maxOrgs).toBe(10)
    }
  })

  it('surfaces errorMessage on API failure without crashing', async () => {
    platformOperatorGateMock.mockReturnValue({ allowed: true, user: platformUser })
    getSettingsMock.mockRejectedValue(new Error('Network error'))

    const result = await load(makeEvent())

    expect(result.allowed).toBe(true)
    if (result.allowed) {
      expect(result.settings).toBeNull()
      expect(result.errorMessage).toBeTruthy()
    }
  })
})
