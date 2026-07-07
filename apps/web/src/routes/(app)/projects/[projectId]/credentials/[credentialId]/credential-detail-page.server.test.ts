import { describe, expect, it, vi, beforeEach } from 'vitest'

const getCredentialMock = vi.hoisted(() => vi.fn())
const listCredentialVersionsMock = vi.hoisted(() => vi.fn())
const listRotationsMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/credentials.js', () => ({
  getCredential: getCredentialMock,
  listCredentialVersions: listCredentialVersionsMock,
}))

vi.mock('$lib/api/rotations.js', () => ({
  listRotations: listRotationsMock,
}))

vi.mock('$lib/server/require-user.js', () => ({
  requireUser: () => ({ orgRole: 'admin' }),
}))

import { ApiClientError } from '$lib/api/client.js'
import { load } from './+page.server.js'

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const credentialId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const rotationId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

function makeEvent(
  url = `https://vault.example.com/projects/${projectId}/credentials/${credentialId}`
) {
  return {
    params: { projectId, credentialId },
    fetch: vi.fn(),
    locals: { user: { orgRole: 'admin' } },
    url: new URL(url),
  } as unknown as Parameters<typeof load>[0]
}

describe('credential detail +page.server.ts rotation section', () => {
  beforeEach(() => {
    getCredentialMock.mockReset()
    listCredentialVersionsMock.mockReset()
    listRotationsMock.mockReset()
    getCredentialMock.mockResolvedValue({ id: credentialId, name: 'Stripe Secret Key' })
    listCredentialVersionsMock.mockResolvedValue({ items: [] })
  })

  it('reports no active rotation when the most recent rotation is completed', async () => {
    listRotationsMock.mockResolvedValueOnce({
      items: [{ id: rotationId, status: 'completed' }],
      page: 1,
      limit: 1,
      total: 1,
      hasMore: false,
    })
    listRotationsMock.mockResolvedValueOnce({
      items: [{ id: rotationId, status: 'completed' }],
      page: 1,
      limit: 10,
      total: 1,
      hasMore: false,
    })

    const result = await load(makeEvent())

    expect(result.activeRotationId).toBeNull()
    expect(result.rotations).toHaveLength(1)
  })

  it('reports an active rotation id when the most recent rotation is in_progress', async () => {
    listRotationsMock.mockResolvedValueOnce({
      items: [{ id: rotationId, status: 'in_progress' }],
      page: 1,
      limit: 1,
      total: 1,
      hasMore: false,
    })
    listRotationsMock.mockResolvedValueOnce({
      items: [{ id: rotationId, status: 'in_progress' }],
      page: 1,
      limit: 10,
      total: 1,
      hasMore: false,
    })

    const result = await load(makeEvent())

    expect(result.activeRotationId).toBe(rotationId)
  })

  it('treats stale_recovery as an active rotation status', async () => {
    listRotationsMock.mockResolvedValueOnce({
      items: [{ id: rotationId, status: 'stale_recovery' }],
      page: 1,
      limit: 1,
      total: 1,
      hasMore: false,
    })
    listRotationsMock.mockResolvedValueOnce({
      items: [{ id: rotationId, status: 'stale_recovery' }],
      page: 1,
      limit: 10,
      total: 1,
      hasMore: false,
    })

    const result = await load(makeEvent())

    expect(result.activeRotationId).toBe(rotationId)
  })

  it('does not treat break_glass_complete as active — it is terminal and must not permanently block starting a new rotation', async () => {
    listRotationsMock.mockResolvedValueOnce({
      items: [{ id: rotationId, status: 'break_glass_complete' }],
      page: 1,
      limit: 1,
      total: 1,
      hasMore: false,
    })
    listRotationsMock.mockResolvedValueOnce({
      items: [{ id: rotationId, status: 'break_glass_complete' }],
      page: 1,
      limit: 10,
      total: 1,
      hasMore: false,
    })

    const result = await load(makeEvent())

    expect(result.activeRotationId).toBeNull()
  })

  it('reports no active rotation and empty history for a brand-new credential', async () => {
    listRotationsMock.mockResolvedValueOnce({
      items: [],
      page: 1,
      limit: 1,
      total: 0,
      hasMore: false,
    })
    listRotationsMock.mockResolvedValueOnce({
      items: [],
      page: 1,
      limit: 10,
      total: 0,
      hasMore: false,
    })

    const result = await load(makeEvent())

    expect(result.activeRotationId).toBeNull()
    expect(result.rotations).toHaveLength(0)
  })

  it('honors a ?page= query param for the paginated history section', async () => {
    listRotationsMock.mockResolvedValueOnce({
      items: [{ id: rotationId, status: 'completed' }],
      page: 1,
      limit: 1,
      total: 12,
      hasMore: true,
    })
    listRotationsMock.mockResolvedValueOnce({
      items: [{ id: 'other-rotation', status: 'completed' }],
      page: 2,
      limit: 10,
      total: 12,
      hasMore: false,
    })

    await load(
      makeEvent(
        `https://vault.example.com/projects/${projectId}/credentials/${credentialId}?page=2`
      )
    )

    expect(listRotationsMock).toHaveBeenLastCalledWith(expect.anything(), projectId, credentialId, {
      page: 2,
      limit: 10,
    })
  })

  it('returns notFound when the credential 404s, without fetching rotations', async () => {
    getCredentialMock.mockRejectedValueOnce(new ApiClientError(404, null, 'not found'))

    const result = await load(makeEvent())

    expect(result.notFound).toBe(true)
    expect(result.activeRotationId).toBeNull()
    expect(result.rotations).toEqual([])
  })

  // AC-1: the credential page's load calls getCredential/listCredentialVersions/listRotations
  // (twice) via Promise.all — every rotation/dependency read is vault-guarded, so a sealed vault
  // 503s any of them. A 503 from any single call is sufficient signal that none of the others
  // could have succeeded either (D1) — the loader does not need to distinguish which call failed.
  it('AC-1: returns vaultSealed: true when getCredential 503s (sealed vault), instead of throwing', async () => {
    getCredentialMock.mockRejectedValueOnce(
      new ApiClientError(
        503,
        { status: 'sealed', message: 'Vault not initialized' },
        'Vault not initialized'
      )
    )

    const result = await load(makeEvent())

    expect(result.vaultSealed).toBe(true)
    expect(result.credential).toBeNull()
    expect(result.notFound).toBe(false)
  })

  it('AC-1: returns vaultSealed: true when the paginated rotations history call 503s', async () => {
    listRotationsMock.mockResolvedValueOnce({
      items: [],
      page: 1,
      limit: 1,
      total: 0,
      hasMore: false,
    })
    listRotationsMock.mockRejectedValueOnce(
      new ApiClientError(
        503,
        { status: 'sealed', message: 'Vault not initialized' },
        'Vault not initialized'
      )
    )

    const result = await load(makeEvent())

    expect(result.vaultSealed).toBe(true)
  })

  it('AC-1 edge: a non-503 ApiClientError (other than 404) still propagates unchanged', async () => {
    getCredentialMock.mockRejectedValueOnce(new ApiClientError(500, null, 'boom'))

    await expect(load(makeEvent())).rejects.toThrow('boom')
  })
})
