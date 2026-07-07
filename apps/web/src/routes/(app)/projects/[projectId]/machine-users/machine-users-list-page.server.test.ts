import { describe, expect, it, vi, beforeEach } from 'vitest'

const listMachineUsersMock = vi.hoisted(() => vi.fn())
const listApiKeysMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/machine-users.js', () => ({
  listMachineUsers: listMachineUsersMock,
  listApiKeys: listApiKeysMock,
}))

vi.mock('$lib/server/require-user.js', () => ({
  requireUser: () => ({ orgRole: 'admin' }),
}))

import { ApiClientError } from '$lib/api/client.js'
import { load } from './+page.server.js'

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function makeEvent() {
  return {
    params: { projectId },
    fetch: vi.fn(),
    locals: { user: { orgRole: 'admin' } },
  } as unknown as Parameters<typeof load>[0]
}

describe('machine-users list +page.server.ts (AC-1)', () => {
  beforeEach(() => {
    listMachineUsersMock.mockReset()
    listApiKeysMock.mockReset()
  })

  it('returns machine users annotated with a keyCount derived from their api-keys total', async () => {
    listMachineUsersMock.mockResolvedValueOnce({
      items: [
        { id: 'mu-1', name: 'bot-a', role: 'member', createdAt: '2026-07-01T00:00:00.000Z' },
        { id: 'mu-2', name: 'bot-b', role: 'viewer', createdAt: '2026-07-02T00:00:00.000Z' },
      ],
      total: 2,
    })
    listApiKeysMock.mockImplementation((_fetch: unknown, machineUserId: string) => {
      if (machineUserId === 'mu-1') return Promise.resolve({ items: [], total: 3 })
      return Promise.resolve({ items: [], total: 0 })
    })

    const result = await load(makeEvent())

    expect(result.notFound).toBe(false)
    expect(result.machineUsers.items).toEqual([
      expect.objectContaining({ id: 'mu-1', keyCount: 3 }),
      expect.objectContaining({ id: 'mu-2', keyCount: 0 }),
    ])
  })

  it('returns an empty list and honest empty state (no fabricated example) when there are zero machine users', async () => {
    listMachineUsersMock.mockResolvedValueOnce({ items: [], total: 0 })

    const result = await load(makeEvent())

    expect(result.machineUsers.items).toEqual([])
    expect(result.notFound).toBe(false)
    expect(listApiKeysMock).not.toHaveBeenCalled()
  })

  it('returns notFound when the project 404s, matching the credential-list-page error pattern', async () => {
    listMachineUsersMock.mockRejectedValueOnce(new ApiClientError(404, null, 'not found'))

    const result = await load(makeEvent())

    expect(result.notFound).toBe(true)
    expect(result.machineUsers.items).toEqual([])
  })

  it('rethrows a non-404 ApiClientError unchanged', async () => {
    listMachineUsersMock.mockRejectedValueOnce(new ApiClientError(500, null, 'boom'))

    await expect(load(makeEvent())).rejects.toThrow('boom')
  })
})
