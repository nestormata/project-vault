import { describe, expect, it, vi, beforeEach } from 'vitest'

const listProjectsMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/projects.js', () => ({
  listProjects: listProjectsMock,
}))

vi.mock('$lib/server/require-user.js', () => ({
  requireUser: (locals: { user: { orgRole: string } }) => locals.user,
}))

import { load } from './+page.server.js'

function makeEvent(orgRole: string) {
  return {
    fetch: vi.fn(),
    locals: { user: { orgRole } },
  } as unknown as Parameters<typeof load>[0]
}

describe('credentials/import +page.server.ts', () => {
  beforeEach(() => {
    listProjectsMock.mockReset()
  })

  it('sets canImport true for an owner', async () => {
    listProjectsMock.mockResolvedValueOnce({ items: [], total: 0 })

    const result = await load(makeEvent('owner'))

    expect(result.canImport).toBe(true)
    expect(result.orgRole).toBe('owner')
  })

  it('sets canImport true for an admin', async () => {
    listProjectsMock.mockResolvedValueOnce({ items: [], total: 0 })

    const result = await load(makeEvent('admin'))

    expect(result.canImport).toBe(true)
  })

  it('sets canImport false for a member/viewer, while still returning the project list', async () => {
    listProjectsMock.mockResolvedValueOnce({ items: [{ id: 'p-1' }], total: 1 })

    const result = await load(makeEvent('member'))

    expect(result.canImport).toBe(false)
    expect(result.projects.items).toEqual([{ id: 'p-1' }])
  })
})
