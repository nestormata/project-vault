import { describe, expect, it, vi, beforeEach } from 'vitest'

const listDomainsMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/domains.js', () => ({
  listDomains: listDomainsMock,
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

describe('domains list +page.server.ts (AC-A1/AC-D1/AC-I2)', () => {
  beforeEach(() => listDomainsMock.mockReset())

  it('loads the list of domains for a viewer+ role', async () => {
    listDomainsMock.mockResolvedValue([{ id: 'd1', domainName: 'example.com' }])
    const result = await load(makeEvent('viewer'))
    expect(result.domains).toEqual([{ id: 'd1', domainName: 'example.com' }])
    expect(result.notFound).toBe(false)
  })

  it('404s to a notFound flag instead of throwing', async () => {
    listDomainsMock.mockRejectedValueOnce(new ApiClientError(404, null, 'not found'))
    const result = await load(makeEvent())
    expect(result.notFound).toBe(true)
    expect(result.domains).toEqual([])
  })

  it('re-throws non-404 errors', async () => {
    listDomainsMock.mockRejectedValueOnce(new ApiClientError(500, null, 'boom'))
    await expect(load(makeEvent())).rejects.toThrow('boom')
  })
})
