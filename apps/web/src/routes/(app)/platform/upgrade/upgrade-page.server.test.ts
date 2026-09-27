import { describe, expect, it, vi, beforeEach } from 'vitest'

const platformOperatorGateMock = vi.hoisted(() => vi.fn())
const fetchHealthMock = vi.hoisted(() => vi.fn())
const probeApiDocsEnabledMock = vi.hoisted(() => vi.fn())
const fetchClientVersionPolicyMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/server/require-platform-operator.js', () => ({
  platformOperatorGate: platformOperatorGateMock,
}))

vi.mock('$lib/api/platform.js', () => ({
  fetchHealth: fetchHealthMock,
  probeApiDocsEnabled: probeApiDocsEnabledMock,
  fetchClientVersionPolicy: fetchClientVersionPolicyMock,
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

const DEV_POLICY_OK = {
  status: 'ok' as const,
  policy: {
    server: { version: 'dev', versionSource: 'development' as const },
    cli: { current: null, minimumSupported: null, withdrawn: [] },
  },
}

const RELEASE_POLICY_OK = {
  status: 'ok' as const,
  policy: {
    server: { version: '1.3.0', versionSource: 'release' as const },
    cli: {
      current: '1.3.0',
      minimumSupported: '1.1.0',
      withdrawn: [{ version: '1.2.1', reason: "Withdrawn by this server's administrator." }],
    },
  },
}

function deferred<T>() {
  let resolveFn!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolveFn = resolvePromise
  })
  return { promise, resolve: resolveFn }
}

function makeEvent() {
  return { fetch: vi.fn(), locals: { user: platformUser } } as unknown as Parameters<typeof load>[0]
}

describe('/platform/upgrade +page.server.ts', () => {
  beforeEach(() => {
    platformOperatorGateMock.mockReset()
    fetchHealthMock.mockReset()
    probeApiDocsEnabledMock.mockReset()
    fetchClientVersionPolicyMock.mockReset()
    fetchClientVersionPolicyMock.mockResolvedValue(DEV_POLICY_OK)
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

  // Story 43.7 AC-2 / AC-5: the CLI version policy is fetched in parallel, only for operators.
  describe('Story 43.7: cliPolicy', () => {
    it('AC-5: a non-operator gets exactly {allowed:false} and no policy request is made', async () => {
      platformOperatorGateMock.mockReturnValue({ allowed: false })

      const result = await load(makeEvent())

      expect(result).toStrictEqual({ allowed: false })
      expect(fetchClientVersionPolicyMock).not.toHaveBeenCalled()
      expect(fetchHealthMock).not.toHaveBeenCalled()
      expect(probeApiDocsEnabledMock).not.toHaveBeenCalled()
    })

    it('AC-2: passes an ok policy through, calling the helper with the load fetch', async () => {
      platformOperatorGateMock.mockReturnValue({ allowed: true, user: platformUser })
      fetchHealthMock.mockResolvedValue({
        status: 'ok',
        version: '1.3.0',
        versionSource: 'release',
      })
      probeApiDocsEnabledMock.mockResolvedValue(false)
      fetchClientVersionPolicyMock.mockResolvedValue(RELEASE_POLICY_OK)
      const event = makeEvent()

      const result = await load(event)

      expect(fetchClientVersionPolicyMock).toHaveBeenCalledTimes(1)
      expect(fetchClientVersionPolicyMock).toHaveBeenCalledWith(event.fetch)
      expect(result).toStrictEqual({
        allowed: true,
        version: '1.3.0',
        versionSource: 'release',
        apiDocsEnabled: false,
        cliPolicy: RELEASE_POLICY_OK,
      })
    })

    it.each([
      'not_supported',
      'rate_limited',
      'api_unavailable',
      'invalid_response',
      'timeout',
      'error',
    ] as const)(
      'AC-2: policy unavailable (%s) leaves the existing fields unchanged',
      async (reason) => {
        platformOperatorGateMock.mockReturnValue({ allowed: true, user: platformUser })
        fetchHealthMock.mockResolvedValue({
          status: 'ok',
          version: '1.3.0',
          versionSource: 'release',
        })
        probeApiDocsEnabledMock.mockResolvedValue(true)
        fetchClientVersionPolicyMock.mockResolvedValue({ status: 'unavailable', reason })

        const result = await load(makeEvent())

        expect(result).toStrictEqual({
          allowed: true,
          version: '1.3.0',
          versionSource: 'release',
          apiDocsEnabled: true,
          cliPolicy: { status: 'unavailable', reason },
        })
      }
    )

    it('AC-2: health unavailable + policy ok → the two panels are independent', async () => {
      platformOperatorGateMock.mockReturnValue({ allowed: true, user: platformUser })
      fetchHealthMock.mockResolvedValue(null)
      probeApiDocsEnabledMock.mockResolvedValue(false)
      fetchClientVersionPolicyMock.mockResolvedValue(RELEASE_POLICY_OK)

      const result = await load(makeEvent())

      expect(result.allowed).toBe(true)
      if (result.allowed) {
        expect(result.version).toBeNull()
        expect(result.versionSource).toBeNull()
        expect(result.cliPolicy).toEqual(RELEASE_POLICY_OK)
      }
    })

    it('AC-2: all three helpers start before any settles (one Promise.all)', async () => {
      platformOperatorGateMock.mockReturnValue({ allowed: true, user: platformUser })
      const health = deferred<unknown>()
      const docs = deferred<boolean>()
      const policy = deferred<unknown>()
      fetchHealthMock.mockReturnValue(health.promise)
      probeApiDocsEnabledMock.mockReturnValue(docs.promise)
      fetchClientVersionPolicyMock.mockReturnValue(policy.promise)

      const pending = load(makeEvent())
      await Promise.resolve()

      expect(fetchHealthMock).toHaveBeenCalledTimes(1)
      expect(probeApiDocsEnabledMock).toHaveBeenCalledTimes(1)
      expect(fetchClientVersionPolicyMock).toHaveBeenCalledTimes(1)

      health.resolve({ status: 'ok', version: 'dev', versionSource: 'development' })
      docs.resolve(false)
      policy.resolve(DEV_POLICY_OK)
      const result = await pending
      expect(result.allowed && result.cliPolicy).toEqual(DEV_POLICY_OK)
    })

    it('AC-5: the serialized load result never carries response headers', async () => {
      platformOperatorGateMock.mockReturnValue({ allowed: true, user: platformUser })
      fetchHealthMock.mockResolvedValue({
        status: 'ok',
        version: '1.3.0',
        versionSource: 'release',
      })
      probeApiDocsEnabledMock.mockResolvedValue(false)
      fetchClientVersionPolicyMock.mockResolvedValue(RELEASE_POLICY_OK)

      const result = await load(makeEvent())

      expect(JSON.stringify(result)).not.toMatch(/set-cookie|x-powered-by/i)
    })
  })
})
