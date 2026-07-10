import { describe, expect, it, vi, beforeEach } from 'vitest'

const listCredentialsMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/credentials.js', () => ({
  listCredentials: listCredentialsMock,
}))

vi.mock('$lib/server/require-user.js', () => ({
  requireUser: (locals: { user: { orgRole: string } }) => locals.user,
}))

import { ApiClientError } from '$lib/api/client.js'
import { load } from './+page.server.js'

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function makeEvent(orgRole = 'member', searchParams: Record<string, string> = {}) {
  const url = new URL('http://localhost/projects/x/credentials')
  for (const [key, value] of Object.entries(searchParams)) url.searchParams.set(key, value)
  return {
    params: { projectId },
    fetch: vi.fn(),
    url,
    locals: { user: { orgRole } },
  } as unknown as Parameters<typeof load>[0]
}

describe('credentials list +page.server.ts', () => {
  beforeEach(() => listCredentialsMock.mockReset())

  it('loads the credential list for a viewer+ role', async () => {
    listCredentialsMock.mockResolvedValue({
      items: [{ id: 'c1' }],
      total: 1,
      page: 1,
      limit: 20,
      hasNext: false,
    })
    const result = await load(makeEvent('viewer'))
    expect(result.credentials.items).toEqual([{ id: 'c1' }])
    expect(result.notFound).toBeUndefined()
  })

  it('applies query-string filters to the returned filter view', async () => {
    listCredentialsMock.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      limit: 20,
      hasNext: false,
    })
    const result = await load(makeEvent('viewer', { status: 'expiring' }))
    expect(result.filters).toBeDefined()
  })

  it('404s to an empty honest page instead of throwing', async () => {
    listCredentialsMock.mockRejectedValueOnce(new ApiClientError(404, null, 'not found'))
    const result = await load(makeEvent())
    expect(result.notFound).toBe(true)
    expect(result.credentials).toEqual({ items: [], total: 0, page: 1, limit: 20, hasNext: false })
  })

  it('re-throws non-404 errors', async () => {
    listCredentialsMock.mockRejectedValueOnce(new ApiClientError(500, null, 'boom'))
    await expect(load(makeEvent())).rejects.toThrow('boom')
  })
})
