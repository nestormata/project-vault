import { describe, expect, it, vi, beforeEach } from 'vitest'

const listProjectMembersMock = vi.hoisted(() => vi.fn())
const listServiceEndpointsMock = vi.hoisted(() => vi.fn())
const getStatusPageConfigMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/org-users.js', () => ({
  listProjectMembers: listProjectMembersMock,
}))
vi.mock('$lib/api/service-endpoints.js', () => ({
  listServiceEndpoints: listServiceEndpointsMock,
}))
vi.mock('$lib/api/status-page.js', () => ({
  getStatusPageConfig: getStatusPageConfigMock,
}))
vi.mock('$lib/server/require-user.js', () => ({
  requireUser: (locals: { user: { orgRole: string; userId: string } }) => locals.user,
}))

import { load } from './+page.server.js'

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function makeEvent(user: { orgRole: string; userId: string }) {
  return {
    params: { projectId },
    fetch: vi.fn(),
    locals: { user },
  } as unknown as Parameters<typeof load>[0]
}

describe('project status-page +page.server.ts', () => {
  beforeEach(() => {
    listProjectMembersMock.mockReset()
    listServiceEndpointsMock.mockReset()
    getStatusPageConfigMock.mockReset()
  })

  it('an org owner can manage even without being a project member (ADR-6.3-07)', async () => {
    listProjectMembersMock.mockResolvedValue([])
    getStatusPageConfigMock.mockResolvedValue({ enabled: true })
    listServiceEndpointsMock.mockResolvedValue([{ id: 'e1' }])

    const result = await load(makeEvent({ orgRole: 'owner', userId: 'u-org-owner' }))

    expect(result.canManage).toBe(true)
    expect(result.config).toEqual({ enabled: true })
    expect(result.serviceEndpoints).toEqual([{ id: 'e1' }])
  })

  it('a project-owner member (non org-owner) can manage', async () => {
    listProjectMembersMock.mockResolvedValue([{ userId: 'u-1', role: 'owner' }])
    getStatusPageConfigMock.mockResolvedValue({ enabled: false })
    listServiceEndpointsMock.mockResolvedValue([])

    const result = await load(makeEvent({ orgRole: 'member', userId: 'u-1' }))

    expect(result.canManage).toBe(true)
  })

  it('a plain member who is not a project owner cannot manage and gets an empty/never-configured form', async () => {
    listProjectMembersMock.mockResolvedValue([{ userId: 'u-1', role: 'member' }])

    const result = await load(makeEvent({ orgRole: 'member', userId: 'u-1' }))

    expect(result.canManage).toBe(false)
    expect(result.config).toEqual({ enabled: false })
    expect(result.serviceEndpoints).toEqual([])
    expect(getStatusPageConfigMock).not.toHaveBeenCalled()
    expect(listServiceEndpointsMock).not.toHaveBeenCalled()
  })

  it('tolerates a failed member lookup by treating the user as not a project member', async () => {
    listProjectMembersMock.mockRejectedValue(new Error('network down'))

    const result = await load(makeEvent({ orgRole: 'member', userId: 'u-1' }))

    expect(result.canManage).toBe(false)
  })
})
