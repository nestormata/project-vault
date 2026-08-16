import { describe, expect, it, vi, beforeEach } from 'vitest'

const getExtensionStatusMock = vi.hoisted(() => vi.fn())
const fetchHealthMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/extensions.js', () => ({
  getExtensionStatus: getExtensionStatusMock,
}))

vi.mock('$lib/api/platform.js', () => ({
  fetchHealth: fetchHealthMock,
}))

vi.mock('$lib/server/require-user.js', () => ({
  requireUser: vi.fn(),
}))

import { ApiClientError } from '$lib/api/client.js'
import { requireUser } from '$lib/server/require-user.js'
import { load } from './+page.server.js'

const requireUserMock = vi.mocked(requireUser)

function makeEvent() {
  return { fetch: vi.fn(), locals: {} } as unknown as Parameters<typeof load>[0]
}

const SAMPLE_MANIFEST = {
  name: 'com.acme.sso-extension',
  apiVersion: '1.2.0',
  capabilities: ['auth-provider'],
  loadedAt: '2026-07-20T10:00:00.000Z',
}

// Story 23.2 AC-12: getExtensionStatus() now resolves the { extension, nativeLoginPolicy }
// envelope rather than a bare manifest-or-null value.
const SAMPLE_POLICY = {
  enabled: true,
  state: 'enabled' as const,
  replacementDeclared: false,
  replacementProven: false,
  replacementProvenAt: null,
  appliedAtBoot: false,
  breakGlassActive: false,
  replacementConfirmedOverride: false,
  extensionStatus: 'not_configured' as const,
  extensionFailureReason: null,
  sessionsLive: 0,
}

function envelope(extension: typeof SAMPLE_MANIFEST | null) {
  return { extension, nativeLoginPolicy: SAMPLE_POLICY }
}

describe('/settings/extensions +page.server.ts', () => {
  beforeEach(() => {
    getExtensionStatusMock.mockReset()
    fetchHealthMock.mockReset()
    requireUserMock.mockReset()
  })

  it('AC-1/AC-2: admin + loaded manifest -> allowed=true with the manifest', async () => {
    requireUserMock.mockReturnValue({ orgRole: 'admin' } as ReturnType<typeof requireUser>)
    getExtensionStatusMock.mockResolvedValue(envelope(SAMPLE_MANIFEST))
    fetchHealthMock.mockResolvedValue({
      status: 'ok',
      version: '1.0.0',
      extensions_status: 'loaded',
    })

    const result = await load(makeEvent())

    expect(result.allowed).toBe(true)
    if (result.allowed) {
      expect(result.manifest).toEqual(SAMPLE_MANIFEST)
      expect(result.healthStatus).toBe('loaded')
      expect(result.errorMessage).toBeNull()
      expect(result.mfaRequired).toBe(false)
    }
  })

  it('AC-3: admin + not-configured -> allowed=true, manifest null, healthStatus not_configured', async () => {
    requireUserMock.mockReturnValue({ orgRole: 'admin' } as ReturnType<typeof requireUser>)
    getExtensionStatusMock.mockResolvedValue(envelope(null))
    fetchHealthMock.mockResolvedValue({
      status: 'ok',
      version: '1.0.0',
      extensions_status: 'not_configured',
    })

    const result = await load(makeEvent())

    expect(result.allowed).toBe(true)
    if (result.allowed) {
      expect(result.manifest).toBeNull()
      expect(result.healthStatus).toBe('not_configured')
      expect(result.errorMessage).toBeNull()
    }
  })

  it('AC-4: admin + load-failed -> allowed=true, manifest null, healthStatus load_failed', async () => {
    requireUserMock.mockReturnValue({ orgRole: 'admin' } as ReturnType<typeof requireUser>)
    getExtensionStatusMock.mockResolvedValue(envelope(null))
    fetchHealthMock.mockResolvedValue({
      status: 'ok',
      version: '1.0.0',
      extensions_status: 'load_failed',
    })

    const result = await load(makeEvent())

    expect(result.allowed).toBe(true)
    if (result.allowed) {
      expect(result.manifest).toBeNull()
      expect(result.healthStatus).toBe('load_failed')
      expect(result.errorMessage).toBeNull()
    }
  })

  it.each(['owner', 'member', 'viewer'] as const)(
    'AC-5: %s role -> allowed=false and getExtensionStatus is never called',
    async (orgRole) => {
      requireUserMock.mockReturnValue({ orgRole } as ReturnType<typeof requireUser>)

      const result = await load(makeEvent())

      expect(result).toEqual({ allowed: false, orgRole })
      expect(getExtensionStatusMock).not.toHaveBeenCalled()
    }
  )

  it('AC-5: GET /health is still fetched even for a blocked non-admin role (safe, unauthenticated)', async () => {
    requireUserMock.mockReturnValue({ orgRole: 'member' } as ReturnType<typeof requireUser>)
    fetchHealthMock.mockResolvedValue({
      status: 'ok',
      version: '1.0.0',
      extensions_status: 'loaded',
    })

    await load(makeEvent())

    expect(fetchHealthMock).toHaveBeenCalled()
  })

  it('AC-7: getExtensionStatus() throwing (non-MFA) -> honest errorMessage', async () => {
    requireUserMock.mockReturnValue({ orgRole: 'admin' } as ReturnType<typeof requireUser>)
    getExtensionStatusMock.mockRejectedValue(new Error('boom'))
    fetchHealthMock.mockResolvedValue({
      status: 'ok',
      version: '1.0.0',
      extensions_status: 'loaded',
    })

    const result = await load(makeEvent())

    expect(result.allowed).toBe(true)
    if (result.allowed) {
      expect(result.errorMessage).toBeTruthy()
      expect(result.manifest).toBeNull()
      expect(result.mfaRequired).toBe(false)
    }
  })

  it('AC-7: fetchHealth() throwing -> honest errorMessage (status resolves null, health throws)', async () => {
    requireUserMock.mockReturnValue({ orgRole: 'admin' } as ReturnType<typeof requireUser>)
    getExtensionStatusMock.mockResolvedValue(envelope(null))
    fetchHealthMock.mockRejectedValue(new Error('boom'))

    const result = await load(makeEvent())

    expect(result.allowed).toBe(true)
    if (result.allowed) {
      expect(result.errorMessage).toBeTruthy()
    }
  })

  it('AC-7 edge: MFA-not-enrolled admin -> mfaRequired distinct state, not the generic error', async () => {
    requireUserMock.mockReturnValue({ orgRole: 'admin' } as ReturnType<typeof requireUser>)
    getExtensionStatusMock.mockRejectedValue(
      new ApiClientError(403, { code: 'mfa_required', message: 'MFA required' }, 'MFA required')
    )
    fetchHealthMock.mockResolvedValue({
      status: 'ok',
      version: '1.0.0',
      extensions_status: 'loaded',
    })

    const result = await load(makeEvent())

    expect(result.allowed).toBe(true)
    if (result.allowed) {
      expect(result.mfaRequired).toBe(true)
      expect(result.errorMessage).toBeNull()
    }
  })

  it('AC-8: manifest present but health disagrees -> loaded state still renders (manifest authoritative)', async () => {
    requireUserMock.mockReturnValue({ orgRole: 'admin' } as ReturnType<typeof requireUser>)
    getExtensionStatusMock.mockResolvedValue(envelope(SAMPLE_MANIFEST))
    fetchHealthMock.mockResolvedValue({
      status: 'ok',
      version: '1.0.0',
      extensions_status: 'not_configured',
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await load(makeEvent())

    expect(result.allowed).toBe(true)
    if (result.allowed) {
      expect(result.manifest).toEqual(SAMPLE_MANIFEST)
      expect(result.healthStatus).toBe('loaded')
    }
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('AC-8 reverse: manifest null but health says loaded -> falls back to not_configured, warns, no crash', async () => {
    requireUserMock.mockReturnValue({ orgRole: 'admin' } as ReturnType<typeof requireUser>)
    getExtensionStatusMock.mockResolvedValue(envelope(null))
    fetchHealthMock.mockResolvedValue({
      status: 'ok',
      version: '1.0.0',
      extensions_status: 'loaded',
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await load(makeEvent())

    expect(result.allowed).toBe(true)
    if (result.allowed) {
      expect(result.manifest).toBeNull()
      expect(result.healthStatus).toBe('not_configured')
      expect(result.errorMessage).toBeNull()
    }
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})
