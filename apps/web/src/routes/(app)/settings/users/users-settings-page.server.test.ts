import { describe, expect, it, vi, beforeEach } from 'vitest'

const listOrgUsersMock = vi.hoisted(() => vi.fn())
const resolveNativeLoginEnabledMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/org-users.js', () => ({
  listOrgUsers: listOrgUsersMock,
}))
vi.mock('$lib/server/require-user.js', () => ({
  requireUser: (locals: { user: { orgRole: string; orgId: string } }) => locals.user,
}))
vi.mock('$lib/server/native-login-status.js', () => ({
  resolveNativeLoginEnabled: resolveNativeLoginEnabledMock,
}))

import { load } from './+page.server.js'

function makeEvent(orgRole: string) {
  return {
    fetch: vi.fn(),
    locals: { user: { orgRole, orgId: 'org-1' } },
  } as unknown as Parameters<typeof load>[0]
}

describe('/settings/users +page.server.ts', () => {
  beforeEach(() => {
    listOrgUsersMock.mockReset()
    resolveNativeLoginEnabledMock.mockReset().mockResolvedValue(true)
  })

  describe('Story 23.2 AC-6 row #10 / G3: nativeLoginEnabled', () => {
    it('defaults true when the health check succeeds', async () => {
      listOrgUsersMock.mockResolvedValue([])
      resolveNativeLoginEnabledMock.mockResolvedValue(true)
      const result = await load(makeEvent('owner'))
      expect(result.nativeLoginEnabled).toBe(true)
    })

    it('is false once native login is excluded', async () => {
      listOrgUsersMock.mockResolvedValue([])
      resolveNativeLoginEnabledMock.mockResolvedValue(false)
      const result = await load(makeEvent('owner'))
      expect(result.nativeLoginEnabled).toBe(false)
    })

    it('fails safe to true when the health check itself fails (returns null)', async () => {
      listOrgUsersMock.mockResolvedValue([])
      resolveNativeLoginEnabledMock.mockResolvedValue(null)
      const result = await load(makeEvent('owner'))
      expect(result.nativeLoginEnabled).toBe(true)
    })
  })

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
