import { describe, expect, it, vi, beforeEach } from 'vitest'

const getExternalShareMetadataMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/credential-shares.js', () => ({
  getExternalShareMetadata: getExternalShareMetadataMock,
}))

import { ApiClientError } from '$lib/api/client.js'
import { load } from './+page.server.js'

const token = 'raw-external-token-value'

function makeEvent() {
  const setHeaders = vi.fn()
  return {
    event: { params: { token }, fetch: vi.fn(), setHeaders } as unknown as Parameters<
      typeof load
    >[0],
    setHeaders,
  }
}

describe('/external-shares/[token] +page.server.ts', () => {
  beforeEach(() => {
    getExternalShareMetadataMock.mockReset()
  })

  it('Story 17.2 AC-10: sets Referrer-Policy: no-referrer on the page document response itself, from the first commit (PR #251 lesson, not an API-only fix)', async () => {
    getExternalShareMetadataMock.mockResolvedValue({
      credentialId: 'cred-1',
      credentialName: 'Stripe Secret Key',
      sharedByDisplayName: 'morgan',
      fieldKey: null,
      expiresAt: '2026-08-01T00:00:00.000Z',
      status: 'active',
    })
    const { event, setHeaders } = makeEvent()

    await load(event)

    expect(setHeaders).toHaveBeenCalledWith({ 'Referrer-Policy': 'no-referrer' })
  })

  it('AC-9: returns share metadata (never a secret value) on a valid token, requiring no session at all', async () => {
    getExternalShareMetadataMock.mockResolvedValue({
      credentialId: 'cred-1',
      credentialName: 'Stripe Secret Key',
      sharedByDisplayName: 'morgan',
      fieldKey: null,
      expiresAt: '2026-08-01T00:00:00.000Z',
      status: 'active',
    })
    const { event } = makeEvent()

    const result = await load(event)

    expect(result.metadata?.credentialName).toBe('Stripe Secret Key')
    expect(result.error).toBeNull()
    expect(getExternalShareMetadataMock).toHaveBeenCalledWith(expect.anything(), token)
  })

  it('a not-found/expired/revoked/malformed token renders the same honest not_found state (AC-17: no distinguishing response shape)', async () => {
    getExternalShareMetadataMock.mockRejectedValue(new ApiClientError(404, null, 'not found'))
    const { event } = makeEvent()

    const result = await load(event)

    expect(result.metadata).toBeNull()
    expect(result.error).toBe('not_found')
  })

  it('rethrows an unexpected error', async () => {
    getExternalShareMetadataMock.mockRejectedValue(new Error('boom'))
    const { event } = makeEvent()

    await expect(load(event)).rejects.toThrow('boom')
  })
})
