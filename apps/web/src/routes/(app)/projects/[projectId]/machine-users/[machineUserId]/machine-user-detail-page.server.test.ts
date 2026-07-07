import { describe, expect, it, vi, beforeEach } from 'vitest'

const getMachineUserMock = vi.hoisted(() => vi.fn())
const listApiKeysMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/machine-users.js', () => ({
  getMachineUser: getMachineUserMock,
  listApiKeys: listApiKeysMock,
}))

vi.mock('$lib/server/require-user.js', () => ({
  requireUser: () => ({ orgRole: 'admin' }),
}))

import { ApiClientError } from '$lib/api/client.js'
import { load } from './+page.server.js'

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const machineUserId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function makeEvent() {
  return {
    params: { projectId, machineUserId },
    fetch: vi.fn(),
    locals: { user: { orgRole: 'admin' } },
  } as unknown as Parameters<typeof load>[0]
}

describe('machine-user detail +page.server.ts (AC-1/AC-2)', () => {
  beforeEach(() => {
    getMachineUserMock.mockReset()
    listApiKeysMock.mockReset()
  })

  it('loads machine-user detail (with scopeBoundary) and its api-key list', async () => {
    getMachineUserMock.mockResolvedValueOnce({
      id: machineUserId,
      projectId,
      name: 'ci-deploy-bot',
      role: 'member',
      deactivatedAt: null,
      scopeBoundary: { canAccess: ['x'], cannotAccess: ['y'] },
    })
    listApiKeysMock.mockResolvedValueOnce({ items: [{ id: 'key-1', isRevoked: false }], total: 1 })

    const result = await load(makeEvent())

    expect(result.notFound).toBe(false)
    expect(result.machineUser?.scopeBoundary).toEqual({ canAccess: ['x'], cannotAccess: ['y'] })
    expect(result.apiKeys.items).toHaveLength(1)
  })

  it('returns notFound (standard 404 empty state) on a cross-org/nonexistent machine user, matching the credential-detail error pattern', async () => {
    getMachineUserMock.mockRejectedValueOnce(new ApiClientError(404, null, 'not found'))

    const result = await load(makeEvent())

    expect(result.notFound).toBe(true)
    expect(result.machineUser).toBeNull()
    expect(result.apiKeys.items).toEqual([])
  })

  it('rethrows a non-404 ApiClientError unchanged', async () => {
    getMachineUserMock.mockRejectedValueOnce(new ApiClientError(500, null, 'boom'))

    await expect(load(makeEvent())).rejects.toThrow('boom')
  })
})
