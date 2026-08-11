import { describe, expect, it, vi, beforeEach } from 'vitest'

const platformOperatorGateMock = vi.hoisted(() => vi.fn())
const fetchHealthMock = vi.hoisted(() => vi.fn())
const probeApiDocsEnabledMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/server/require-platform-operator.js', () => ({
  platformOperatorGate: platformOperatorGateMock,
}))

vi.mock('$lib/api/platform.js', () => ({
  fetchHealth: fetchHealthMock,
  probeApiDocsEnabled: probeApiDocsEnabledMock,
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

describe('/platform/upgrade +page.server.ts', () => {
  beforeEach(() => {
    platformOperatorGateMock.mockReset()
    fetchHealthMock.mockReset()
    probeApiDocsEnabledMock.mockReset()
  })

  it('AC-A3: returns allowed=false for non-platform-operator', async () => {
    platformOperatorGateMock.mockReturnValue({ allowed: false })

    const result = await load(makeEvent())

    expect(result.allowed).toBe(false)
  })

  it('AC-J1: returns version from GET /health', async () => {
    platformOperatorGateMock.mockReturnValue({ allowed: true, user: platformUser })
    fetchHealthMock.mockResolvedValue({ status: 'ok', version: '0.9.0', versionSource: 'release' })
    probeApiDocsEnabledMock.mockResolvedValue(false)

    const result = await load(makeEvent())

    expect(result.allowed).toBe(true)
    if (result.allowed) {
      expect(result.version).toBe('0.9.0')
      expect(result.apiDocsEnabled).toBe(false)
    }
  })

  it('AC-J1 edge: returns null version if GET /health fails', async () => {
    platformOperatorGateMock.mockReturnValue({ allowed: true, user: platformUser })
    fetchHealthMock.mockResolvedValue(null)
    probeApiDocsEnabledMock.mockResolvedValue(false)

    const result = await load(makeEvent())

    expect(result.allowed).toBe(true)
    if (result.allowed) {
      expect(result.version).toBeNull()
      expect(result.versionSource).toBeNull()
    }
  })

  // Story 9.10 AC-1/AC-3: surface versionSource alongside version so the page can distinguish a
  // real release from the documented dev fallback — same live API/build metadata as /health.
  describe('Story 9.10: versionSource', () => {
    it('AC-1/AC-3: returns versionSource "release" when /health reports a real release', async () => {
      platformOperatorGateMock.mockReturnValue({ allowed: true, user: platformUser })
      fetchHealthMock.mockResolvedValue({
        status: 'ok',
        version: '1.0.2',
        versionSource: 'release',
      })
      probeApiDocsEnabledMock.mockResolvedValue(false)

      const result = await load(makeEvent())

      expect(result.allowed).toBe(true)
      if (result.allowed) {
        expect(result.version).toBe('1.0.2')
        expect(result.versionSource).toBe('release')
      }
    })

    it('AC-1: returns versionSource "development" when /health reports the dev fallback', async () => {
      platformOperatorGateMock.mockReturnValue({ allowed: true, user: platformUser })
      fetchHealthMock.mockResolvedValue({
        status: 'ok',
        version: 'dev',
        versionSource: 'development',
      })
      probeApiDocsEnabledMock.mockResolvedValue(false)

      const result = await load(makeEvent())

      expect(result.allowed).toBe(true)
      if (result.allowed) {
        expect(result.version).toBe('dev')
        expect(result.versionSource).toBe('development')
      }
    })

    it('AC-3 edge: returns null versionSource when /health fetch fails (honest unknown state)', async () => {
      platformOperatorGateMock.mockReturnValue({ allowed: true, user: platformUser })
      fetchHealthMock.mockResolvedValue(null)
      probeApiDocsEnabledMock.mockResolvedValue(false)

      const result = await load(makeEvent())

      expect(result.allowed).toBe(true)
      if (result.allowed) {
        expect(result.versionSource).toBeNull()
      }
    })
  })

  it('AC-J3: apiDocsEnabled=true when probe returns true', async () => {
    platformOperatorGateMock.mockReturnValue({ allowed: true, user: platformUser })
    fetchHealthMock.mockResolvedValue({ status: 'ok', version: '0.9.0' })
    probeApiDocsEnabledMock.mockResolvedValue(true)

    const result = await load(makeEvent())

    expect(result.allowed).toBe(true)
    if (result.allowed) {
      expect(result.apiDocsEnabled).toBe(true)
    }
  })
})
