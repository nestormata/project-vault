import { describe, expect, it, vi, beforeEach } from 'vitest'

const getProjectMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/projects.js', () => ({
  getProject: getProjectMock,
}))

vi.mock('$lib/server/require-user.js', () => ({
  requireUser: (locals: { user: { orgRole: string } }) => locals.user,
}))

import { ApiClientError } from '$lib/api/client.js'
import { load } from './+layout.server.js'

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function makeEvent(orgRole = 'member') {
  return {
    params: { projectId },
    fetch: vi.fn(),
    locals: { user: { orgRole } },
  } as unknown as Parameters<typeof load>[0]
}

describe('project [projectId] +layout.server.ts (AC-5/AC-8/AC-10 sub-nav data)', () => {
  beforeEach(() => getProjectMock.mockReset())

  it('supplies project + orgRole to every sub-route under this layout', async () => {
    const project = { id: projectId, archivedAt: null }
    getProjectMock.mockResolvedValueOnce(project)

    const result = await load(makeEvent('admin'))

    expect(result).toEqual({ projectId, orgRole: 'admin', project })
  })

  it('degrades to project: null on a 404/foreign-org project instead of throwing', async () => {
    getProjectMock.mockRejectedValueOnce(new ApiClientError(404, null, 'not found'))

    const result = await load(makeEvent())

    expect(result).toEqual({ projectId, orgRole: 'member', project: null })
  })

  it('re-throws non-404 errors (e.g. malformed ID) unmodified', async () => {
    getProjectMock.mockRejectedValueOnce(new ApiClientError(422, null, 'validation failed'))

    await expect(load(makeEvent())).rejects.toThrow('validation failed')
  })
})
