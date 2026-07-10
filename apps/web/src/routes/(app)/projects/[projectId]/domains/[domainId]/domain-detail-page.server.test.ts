import { describe, expect, it, vi, beforeEach } from 'vitest'

const getDomainMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/domains.js', () => ({
  getDomain: getDomainMock,
}))

vi.mock('$lib/server/require-user.js', () => ({
  requireUser: (locals: { user: { orgRole: string } }) => locals.user,
}))

import { ApiClientError } from '$lib/api/client.js'
import { load } from './+page.server.js'

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const domainId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

function makeEvent(orgRole = 'member') {
  return {
    params: { projectId, domainId },
    fetch: vi.fn(),
    locals: { user: { orgRole } },
  } as unknown as Parameters<typeof load>[0]
}

describe('domain detail +page.server.ts', () => {
  beforeEach(() => getDomainMock.mockReset())

  it('loads the domain for a viewer+ role', async () => {
    getDomainMock.mockResolvedValue({ id: domainId, domainName: 'example.com' })
    const result = await load(makeEvent('viewer'))
    expect(result.domain).toEqual({ id: domainId, domainName: 'example.com' })
    expect(result.notFound).toBe(false)
  })

  it('404s to a notFound flag instead of throwing', async () => {
    getDomainMock.mockRejectedValueOnce(new ApiClientError(404, null, 'not found'))
    const result = await load(makeEvent())
    expect(result.notFound).toBe(true)
    expect(result.domain).toBeNull()
  })

  it('re-throws non-404 errors', async () => {
    getDomainMock.mockRejectedValueOnce(new ApiClientError(500, null, 'boom'))
    await expect(load(makeEvent())).rejects.toThrow('boom')
  })
})
