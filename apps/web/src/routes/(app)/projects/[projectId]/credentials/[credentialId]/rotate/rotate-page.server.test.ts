import { describe, expect, it, vi, beforeEach } from 'vitest'
import { isRedirect } from '@sveltejs/kit'

const listCredentialDependenciesMock = vi.hoisted(() => vi.fn())
const listRotationsMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/credentials.js', () => ({
  listCredentialDependencies: listCredentialDependenciesMock,
}))

vi.mock('$lib/api/rotations.js', () => ({
  listRotations: listRotationsMock,
}))

import { load } from './+page.server.js'

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const credentialId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const rotationId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

function makeEvent(orgRole: string) {
  return {
    params: { projectId, credentialId },
    fetch: vi.fn(),
    locals: { user: { orgRole } },
  } as unknown as Parameters<typeof load>[0]
}

describe('/rotate +page.server.ts', () => {
  beforeEach(() => {
    listCredentialDependenciesMock.mockReset()
    listRotationsMock.mockReset()
  })

  it('AC-6: member/viewer never triggers the dependencies or rotations fetch', async () => {
    const result = await load(makeEvent('member'))

    expect(listCredentialDependenciesMock).not.toHaveBeenCalled()
    expect(listRotationsMock).not.toHaveBeenCalled()
    expect(result.canManage).toBe(false)
  })

  it('AC-3: admin sees the dependency preview when no rotation is active', async () => {
    listRotationsMock.mockResolvedValueOnce({
      items: [{ id: rotationId, status: 'completed' }],
      page: 1,
      limit: 1,
      total: 1,
      hasMore: false,
    })
    listCredentialDependenciesMock.mockResolvedValueOnce({
      items: [{ id: 'd1', systemName: 'billing-worker (production)' }],
      hasDependencies: true,
    })

    const result = await load(makeEvent('admin'))

    expect(result.canManage).toBe(true)
    expect(result.dependencies?.hasDependencies).toBe(true)
  })

  it('redirects to the active rotation detail page instead of rendering the form', async () => {
    listRotationsMock.mockResolvedValueOnce({
      items: [{ id: rotationId, status: 'in_progress' }],
      page: 1,
      limit: 1,
      total: 1,
      hasMore: false,
    })

    let caught: unknown
    try {
      await load(makeEvent('owner'))
    } catch (error) {
      caught = error
    }

    expect(isRedirect(caught)).toBe(true)
    const redirect = caught as { status: number; location: string }
    expect(redirect.location).toBe(
      `/projects/${projectId}/credentials/${credentialId}/rotations/${rotationId}`
    )
    expect(listCredentialDependenciesMock).not.toHaveBeenCalled()
  })

  it('does not redirect away for a break_glass_complete rotation — it is terminal and must not permanently block a new rotation', async () => {
    listRotationsMock.mockResolvedValueOnce({
      items: [{ id: rotationId, status: 'break_glass_complete' }],
      page: 1,
      limit: 1,
      total: 1,
      hasMore: false,
    })
    listCredentialDependenciesMock.mockResolvedValueOnce({
      items: [],
      hasDependencies: false,
    })

    const result = await load(makeEvent('admin'))

    expect(result.canManage).toBe(true)
    expect(listCredentialDependenciesMock).toHaveBeenCalled()
  })
})
