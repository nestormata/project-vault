import { describe, expect, it, vi, beforeEach } from 'vitest'

const getServiceMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/services.js', () => ({
  getService: getServiceMock,
}))

vi.mock('$lib/server/require-user.js', () => ({
  requireUser: (locals: { user: { orgRole: string } }) => locals.user,
}))

import { ApiClientError } from '$lib/api/client.js'
import { load } from './+page.server.js'

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const serviceId = 'ffffffff-ffff-4fff-8fff-ffffffffffff'

function makeEvent(orgRole = 'member') {
  return {
    params: { projectId, serviceId },
    fetch: vi.fn(),
    locals: { user: { orgRole } },
  } as unknown as Parameters<typeof load>[0]
}

describe('service detail +page.server.ts', () => {
  beforeEach(() => getServiceMock.mockReset())

  it('loads the service for a viewer+ role', async () => {
    getServiceMock.mockResolvedValue({ id: serviceId, name: 'payments' })
    const result = await load(makeEvent('viewer'))
    expect(result.service).toEqual({ id: serviceId, name: 'payments' })
    expect(result.notFound).toBe(false)
  })

  it('404s to a notFound flag instead of throwing', async () => {
    getServiceMock.mockRejectedValueOnce(new ApiClientError(404, null, 'not found'))
    const result = await load(makeEvent())
    expect(result.notFound).toBe(true)
    expect(result.service).toBeNull()
  })

  it('re-throws non-404 errors', async () => {
    getServiceMock.mockRejectedValueOnce(new ApiClientError(500, null, 'boom'))
    await expect(load(makeEvent())).rejects.toThrow('boom')
  })
})
