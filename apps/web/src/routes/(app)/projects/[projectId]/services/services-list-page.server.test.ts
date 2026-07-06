import { describe, expect, it, vi, beforeEach } from 'vitest'

const listServicesMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/services.js', () => ({
  listServices: listServicesMock,
}))

vi.mock('$lib/server/require-user.js', () => ({
  requireUser: (locals: { user: { orgRole: string } }) => locals.user,
}))

import { ApiClientError } from '$lib/api/client.js'
import { load } from './+page.server.js'

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function makeEvent(orgRole = 'member') {
  return {
    params: { projectId },
    fetch: vi.fn(),
    locals: { user: { orgRole } },
  } as unknown as Parameters<typeof load>[0]
}

describe('services list +page.server.ts (AC-A1/AC-B1/AC-I2)', () => {
  beforeEach(() => {
    listServicesMock.mockReset()
  })

  it('AC-B2: loads the list of services for a viewer+ role', async () => {
    listServicesMock.mockResolvedValue([{ id: 's1', name: 'AWS Hosting' }])

    const result = await load(makeEvent('viewer'))

    expect(result.projectId).toBe(projectId)
    expect(result.orgRole).toBe('viewer')
    expect(result.services).toEqual([{ id: 's1', name: 'AWS Hosting' }])
    expect(result.notFound).toBe(false)
  })

  it('AC-A1 edge: cross-org/nonexistent project 404s to a notFound flag instead of throwing', async () => {
    listServicesMock.mockRejectedValueOnce(new ApiClientError(404, null, 'not found'))

    const result = await load(makeEvent())

    expect(result.notFound).toBe(true)
    expect(result.services).toEqual([])
  })

  it('re-throws non-404 errors', async () => {
    listServicesMock.mockRejectedValueOnce(new ApiClientError(500, null, 'boom'))

    await expect(load(makeEvent())).rejects.toThrow('boom')
  })
})
