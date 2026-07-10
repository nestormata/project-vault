import { describe, expect, it, vi, beforeEach } from 'vitest'

const getServiceEndpointMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/service-endpoints.js', () => ({
  getServiceEndpoint: getServiceEndpointMock,
}))

vi.mock('$lib/server/require-user.js', () => ({
  requireUser: (locals: { user: { orgRole: string } }) => locals.user,
}))

import { ApiClientError } from '$lib/api/client.js'
import { load } from './+page.server.js'

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const serviceEndpointId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'

function makeEvent(orgRole = 'member') {
  return {
    params: { projectId, serviceEndpointId },
    fetch: vi.fn(),
    locals: { user: { orgRole } },
  } as unknown as Parameters<typeof load>[0]
}

describe('service endpoint detail +page.server.ts', () => {
  beforeEach(() => getServiceEndpointMock.mockReset())

  it('loads the endpoint for a viewer+ role', async () => {
    getServiceEndpointMock.mockResolvedValue({ id: serviceEndpointId, name: 'edge-1' })
    const result = await load(makeEvent('viewer'))
    expect(result.endpoint).toEqual({ id: serviceEndpointId, name: 'edge-1' })
    expect(result.notFound).toBe(false)
  })

  it('404s to a notFound flag instead of throwing', async () => {
    getServiceEndpointMock.mockRejectedValueOnce(new ApiClientError(404, null, 'not found'))
    const result = await load(makeEvent())
    expect(result.notFound).toBe(true)
    expect(result.endpoint).toBeNull()
  })

  it('re-throws non-404 errors', async () => {
    getServiceEndpointMock.mockRejectedValueOnce(new ApiClientError(500, null, 'boom'))
    await expect(load(makeEvent())).rejects.toThrow('boom')
  })
})
