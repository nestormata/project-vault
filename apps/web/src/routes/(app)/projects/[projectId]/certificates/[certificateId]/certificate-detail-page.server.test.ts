import { describe, expect, it, vi, beforeEach } from 'vitest'

const getCertificateMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/certificates.js', () => ({
  getCertificate: getCertificateMock,
}))

vi.mock('$lib/server/require-user.js', () => ({
  requireUser: (locals: { user: { orgRole: string } }) => locals.user,
}))

import { ApiClientError } from '$lib/api/client.js'
import { load } from './+page.server.js'

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const certificateId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

function makeEvent(orgRole = 'member') {
  return {
    params: { projectId, certificateId },
    fetch: vi.fn(),
    locals: { user: { orgRole } },
  } as unknown as Parameters<typeof load>[0]
}

describe('certificate detail +page.server.ts', () => {
  beforeEach(() => getCertificateMock.mockReset())

  it('loads the certificate for a viewer+ role', async () => {
    getCertificateMock.mockResolvedValue({ id: certificateId, commonName: 'example.com' })
    const result = await load(makeEvent('viewer'))
    expect(result.certificate).toEqual({ id: certificateId, commonName: 'example.com' })
    expect(result.notFound).toBe(false)
  })

  it('404s to a notFound flag instead of throwing', async () => {
    getCertificateMock.mockRejectedValueOnce(new ApiClientError(404, null, 'not found'))
    const result = await load(makeEvent())
    expect(result.notFound).toBe(true)
    expect(result.certificate).toBeNull()
  })

  it('re-throws non-404 errors', async () => {
    getCertificateMock.mockRejectedValueOnce(new ApiClientError(500, null, 'boom'))
    await expect(load(makeEvent())).rejects.toThrow('boom')
  })
})
