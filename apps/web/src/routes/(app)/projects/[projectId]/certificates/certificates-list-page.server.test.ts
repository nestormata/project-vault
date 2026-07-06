import { describe, expect, it, vi, beforeEach } from 'vitest'

const listCertificatesMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/certificates.js', () => ({
  listCertificates: listCertificatesMock,
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

describe('certificates list +page.server.ts (AC-A1/AC-C1/AC-I2)', () => {
  beforeEach(() => listCertificatesMock.mockReset())

  it('loads the list of certificates for a viewer+ role', async () => {
    listCertificatesMock.mockResolvedValue([{ id: 'c1', domain: 'api.example.com' }])
    const result = await load(makeEvent('viewer'))
    expect(result.certificates).toEqual([{ id: 'c1', domain: 'api.example.com' }])
    expect(result.notFound).toBe(false)
  })

  it('404s to a notFound flag instead of throwing', async () => {
    listCertificatesMock.mockRejectedValueOnce(new ApiClientError(404, null, 'not found'))
    const result = await load(makeEvent())
    expect(result.notFound).toBe(true)
    expect(result.certificates).toEqual([])
  })

  it('re-throws non-404 errors', async () => {
    listCertificatesMock.mockRejectedValueOnce(new ApiClientError(500, null, 'boom'))
    await expect(load(makeEvent())).rejects.toThrow('boom')
  })
})
