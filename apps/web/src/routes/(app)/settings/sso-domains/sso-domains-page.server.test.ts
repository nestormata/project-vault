import { beforeEach, describe, expect, it, vi } from 'vitest'

const listOrgSsoDomainsMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/org-sso-domains.js', () => ({
  listOrgSsoDomains: listOrgSsoDomainsMock,
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

const SAMPLE_DOMAIN = {
  id: '00000000-0000-4000-8000-000000000001',
  domain: 'acme.com',
  providerName: 'test.mock-sso-extension',
  createdAt: '2026-07-27T10:00:00.000Z',
}

describe('/settings/sso-domains +page.server.ts', () => {
  beforeEach(() => {
    listOrgSsoDomainsMock.mockReset()
    requireUserMock.mockReset()
  })

  it('AC-1/AC-5: admin -> allowed=true with the org domain list', async () => {
    requireUserMock.mockReturnValue({ orgRole: 'admin' } as ReturnType<typeof requireUser>)
    listOrgSsoDomainsMock.mockResolvedValue([SAMPLE_DOMAIN])

    const result = await load(makeEvent())

    expect(result.allowed).toBe(true)
    if (result.allowed) {
      expect(result.domains).toEqual([SAMPLE_DOMAIN])
      expect(result.errorMessage).toBeNull()
      expect(result.mfaRequired).toBe(false)
    }
  })

  it('AC-5: owner -> allowed=true (minimumRole admin includes owner)', async () => {
    requireUserMock.mockReturnValue({ orgRole: 'owner' } as ReturnType<typeof requireUser>)
    listOrgSsoDomainsMock.mockResolvedValue([])

    const result = await load(makeEvent())

    expect(result.allowed).toBe(true)
    if (result.allowed) expect(result.domains).toEqual([])
  })

  it('AC-1: an empty array is an honest empty state, not an error', async () => {
    requireUserMock.mockReturnValue({ orgRole: 'admin' } as ReturnType<typeof requireUser>)
    listOrgSsoDomainsMock.mockResolvedValue([])

    const result = await load(makeEvent())

    expect(result.allowed).toBe(true)
    if (result.allowed) {
      expect(result.domains).toEqual([])
      expect(result.errorMessage).toBeNull()
    }
  })

  it.each(['member', 'viewer'] as const)(
    'AC-5: %s role -> allowed=false and listOrgSsoDomains is never called',
    async (orgRole) => {
      requireUserMock.mockReturnValue({ orgRole } as ReturnType<typeof requireUser>)

      const result = await load(makeEvent())

      expect(result).toEqual({ allowed: false, orgRole })
      expect(listOrgSsoDomainsMock).not.toHaveBeenCalled()
    }
  )

  it('AC-5: listOrgSsoDomains() throwing (non-MFA) -> honest errorMessage, empty domains', async () => {
    requireUserMock.mockReturnValue({ orgRole: 'admin' } as ReturnType<typeof requireUser>)
    listOrgSsoDomainsMock.mockRejectedValue(new Error('boom'))

    const result = await load(makeEvent())

    expect(result.allowed).toBe(true)
    if (result.allowed) {
      expect(result.errorMessage).toBeTruthy()
      expect(result.domains).toEqual([])
      expect(result.mfaRequired).toBe(false)
    }
  })

  it('AC-6 edge: MFA-not-enrolled admin -> mfaRequired distinct state, not the generic error', async () => {
    requireUserMock.mockReturnValue({ orgRole: 'admin' } as ReturnType<typeof requireUser>)
    listOrgSsoDomainsMock.mockRejectedValue(
      new ApiClientError(403, { code: 'mfa_required', message: 'MFA required' }, 'MFA required')
    )

    const result = await load(makeEvent())

    expect(result.allowed).toBe(true)
    if (result.allowed) {
      expect(result.mfaRequired).toBe(true)
      expect(result.errorMessage).toBeNull()
      expect(result.domains).toEqual([])
    }
  })
})
