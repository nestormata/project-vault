import { beforeEach, describe, expect, it, vi } from 'vitest'

const listExternalIdentitiesMock = vi.hoisted(() => vi.fn())
const listOrgUsersMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/external-identities.js', () => ({
  listExternalIdentities: listExternalIdentitiesMock,
}))

vi.mock('$lib/api/org-users.js', () => ({
  listOrgUsers: listOrgUsersMock,
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

const SAMPLE_IDENTITY = {
  id: '00000000-0000-4000-8000-000000000001',
  userId: '00000000-0000-4000-8000-000000000002',
  email: 'alex@acme.com',
  providerName: 'test.mock-sso-extension',
  externalSubject: 'alex-sso-subject-123',
  createdAt: '2026-07-28T14:03:11.000Z',
}

const SAMPLE_ORG_USER = {
  userId: '00000000-0000-4000-8000-000000000002',
  email: 'alex@acme.com',
  displayName: 'alex@acme.com',
  orgRole: 'member' as const,
  status: 'active' as const,
  projects: [],
}

describe('/settings/external-identities +page.server.ts', () => {
  beforeEach(() => {
    listExternalIdentitiesMock.mockReset()
    listOrgUsersMock.mockReset()
    requireUserMock.mockReset()
  })

  it('AC-1/AC-12: admin -> allowed=true with the org identity list and member list', async () => {
    requireUserMock.mockReturnValue({ orgRole: 'admin' } as ReturnType<typeof requireUser>)
    listExternalIdentitiesMock.mockResolvedValue([SAMPLE_IDENTITY])
    listOrgUsersMock.mockResolvedValue([SAMPLE_ORG_USER])

    const result = await load(makeEvent())

    expect(result.allowed).toBe(true)
    if (result.allowed) {
      expect(result.identities).toEqual([SAMPLE_IDENTITY])
      expect(result.orgUsers).toEqual([SAMPLE_ORG_USER])
      expect(result.errorMessage).toBeNull()
      expect(result.mfaRequired).toBe(false)
    }
  })

  it('AC-1: an empty array is an honest empty state, not an error', async () => {
    requireUserMock.mockReturnValue({ orgRole: 'admin' } as ReturnType<typeof requireUser>)
    listExternalIdentitiesMock.mockResolvedValue([])
    listOrgUsersMock.mockResolvedValue([])

    const result = await load(makeEvent())

    expect(result.allowed).toBe(true)
    if (result.allowed) {
      expect(result.identities).toEqual([])
      expect(result.errorMessage).toBeNull()
    }
  })

  it.each(['owner', 'member', 'viewer'] as const)(
    'AC-4: %s role -> allowed=false and listExternalIdentities/listOrgUsers are never called',
    async (orgRole) => {
      requireUserMock.mockReturnValue({ orgRole } as ReturnType<typeof requireUser>)

      const result = await load(makeEvent())

      expect(result).toEqual({ allowed: false, orgRole })
      expect(listExternalIdentitiesMock).not.toHaveBeenCalled()
      expect(listOrgUsersMock).not.toHaveBeenCalled()
    }
  )

  it('AC-1: listExternalIdentities() throwing (non-MFA) -> honest errorMessage, empty identities', async () => {
    requireUserMock.mockReturnValue({ orgRole: 'admin' } as ReturnType<typeof requireUser>)
    listExternalIdentitiesMock.mockRejectedValue(new Error('boom'))
    listOrgUsersMock.mockResolvedValue([])

    const result = await load(makeEvent())

    expect(result.allowed).toBe(true)
    if (result.allowed) {
      expect(result.errorMessage).toBeTruthy()
      expect(result.identities).toEqual([])
      expect(result.mfaRequired).toBe(false)
    }
  })

  it('AC-5: 403 mfa_required -> distinct MFA message, not the generic error', async () => {
    requireUserMock.mockReturnValue({ orgRole: 'admin' } as ReturnType<typeof requireUser>)
    listExternalIdentitiesMock.mockRejectedValue(
      new ApiClientError(403, { code: 'mfa_required', message: 'MFA required' }, 'MFA required')
    )
    listOrgUsersMock.mockResolvedValue([])

    const result = await load(makeEvent())

    expect(result.allowed).toBe(true)
    if (result.allowed) {
      expect(result.mfaRequired).toBe(true)
      expect(result.errorMessage).toBeNull()
      expect(result.identities).toEqual([])
    }
  })
})
