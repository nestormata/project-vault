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

  it.each(['stale_recovery', 'break_glass_complete'])(
    'treats %s as an active rotation status',
    async (status) => {
      listRotationsMock.mockResolvedValueOnce({
        items: [{ id: rotationId, status }],
        page: 1,
        limit: 1,
        total: 1,
        hasMore: false,
      })
      listRotationsMock.mockResolvedValueOnce({
        items: [{ id: rotationId, status }],
        page: 1,
        limit: 10,
        total: 1,
        hasMore: false,
      })

      const result = await load(makeEvent())

      expect(result.activeRotationId).toBe(rotationId)
    }
  )

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
})
