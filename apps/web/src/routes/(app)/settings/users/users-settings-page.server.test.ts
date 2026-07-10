import { describe, expect, it, vi, beforeEach } from 'vitest'

const listOrgUsersMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/org-users.js', () => ({
  listOrgUsers: listOrgUsersMock,
}))
vi.mock('$lib/server/require-user.js', () => ({
  requireUser: (locals: { user: { orgRole: string; orgId: string } }) => locals.user,
}))

import { load } from './+page.server.js'

function makeEvent(orgRole: string) {
  return {
    fetch: vi.fn(),
    locals: { user: { orgRole, orgId: 'org-1' } },
  } as unknown as Parameters<typeof load>[0]
}

describe('/settings/users +page.server.ts', () => {
  beforeEach(() => listOrgUsersMock.mockReset())

  it('an owner can manage and sees the loaded user list', async () => {
    listOrgUsersMock.mockResolvedValue([{ id: 'u1' }])
    const result = await load(makeEvent('owner'))
    expect(result.canManage).toBe(true)
    expect(result.users).toEqual([{ id: 'u1' }])
  })

  it('an admin can manage and sees the loaded user list', async () => {
    listOrgUsersMock.mockResolvedValue([{ id: 'u2' }])
    const result = await load(makeEvent('admin'))
    expect(result.canManage).toBe(true)
    expect(result.users).toEqual([{ id: 'u2' }])
  })

  it('a member cannot manage and the user list is never fetched', async () => {
    const result = await load(makeEvent('member'))
    expect(result.canManage).toBe(false)
    expect(result.users).toEqual([])
    expect(listOrgUsersMock).not.toHaveBeenCalled()
  })

  it('tolerates a failed user list fetch by returning an empty list', async () => {
    listOrgUsersMock.mockRejectedValueOnce(new Error('network down'))
    const result = await load(makeEvent('owner'))
    expect(result.users).toEqual([])
  })
})
