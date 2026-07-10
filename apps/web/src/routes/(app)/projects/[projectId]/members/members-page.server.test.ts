import { describe, expect, it, vi, beforeEach } from 'vitest'

const listInvitationsMock = vi.hoisted(() => vi.fn())
const listProjectMembersMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/invitations.js', () => ({
  listInvitations: listInvitationsMock,
}))

vi.mock('$lib/api/org-users.js', () => ({
  listProjectMembers: listProjectMembersMock,
}))

vi.mock('$lib/server/require-user.js', () => ({
  requireUser: (locals: { user: { orgRole: string; userId: string } }) => locals.user,
}))

import { load } from './+page.server.js'

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const userId = 'user-1'

function makeEvent(orgRole: string) {
  return {
    params: { projectId },
    fetch: vi.fn(),
    locals: { user: { orgRole, userId } },
  } as unknown as Parameters<typeof load>[0]
}

describe('project members +page.server.ts (AC-10)', () => {
  beforeEach(() => {
    listInvitationsMock.mockReset()
    listProjectMembersMock.mockReset()
  })

  it('an org owner fetches invitations and members; being the project owner grants manage+transfer', async () => {
    listInvitationsMock.mockResolvedValueOnce([{ id: 'inv-1' }])
    listProjectMembersMock.mockResolvedValueOnce([{ userId, role: 'owner' }])

    const result = await load(makeEvent('owner'))

    expect(listInvitationsMock).toHaveBeenCalledWith(expect.any(Function), projectId)
    expect(result.canManage).toBe(true)
    expect(result.canManageMembers).toBe(true)
    expect(result.canTransferOwnership).toBe(true)
    expect(result.invitations).toEqual([{ id: 'inv-1' }])
    expect(result.members).toEqual([{ userId, role: 'owner' }])
  })

  it('an org admin fetches invitations too, and degrades invitations to [] if the call throws', async () => {
    listInvitationsMock.mockRejectedValueOnce(new Error('boom'))
    listProjectMembersMock.mockResolvedValueOnce([])

    const result = await load(makeEvent('admin'))

    expect(result.canManage).toBe(true)
    expect(result.invitations).toEqual([])
  })

  it('a plain org member never calls listInvitations, and without a matching project role has no manage/transfer rights', async () => {
    listProjectMembersMock.mockResolvedValueOnce([{ userId: 'someone-else', role: 'member' }])

    const result = await load(makeEvent('member'))

    expect(listInvitationsMock).not.toHaveBeenCalled()
    expect(result.canManage).toBe(false)
    expect(result.canManageMembers).toBe(false)
    expect(result.canTransferOwnership).toBe(false)
    expect(result.invitations).toEqual([])
  })

  it('degrades members to [] when listProjectMembers throws', async () => {
    listProjectMembersMock.mockRejectedValueOnce(new Error('down'))

    const result = await load(makeEvent('viewer'))

    expect(result.members).toEqual([])
    expect(result.canManageMembers).toBe(false)
  })

  it('a project admin (but only an org member) still gets canManageMembers via the project-role axis, without transfer rights', async () => {
    listProjectMembersMock.mockResolvedValueOnce([{ userId, role: 'admin' }])

    const result = await load(makeEvent('member'))

    expect(result.canManageMembers).toBe(true)
    expect(result.canTransferOwnership).toBe(false)
  })

  it('a project owner who is only an org member still gets transfer rights via the project-role axis', async () => {
    listProjectMembersMock.mockResolvedValueOnce([{ userId, role: 'owner' }])

    const result = await load(makeEvent('viewer'))

    expect(result.canManageMembers).toBe(true)
    expect(result.canTransferOwnership).toBe(true)
  })
})
