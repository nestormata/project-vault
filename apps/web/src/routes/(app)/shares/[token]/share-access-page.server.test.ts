import { describe, expect, it, vi, beforeEach } from 'vitest'

const getShareMetadataMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/credential-shares.js', () => ({
  getShareMetadata: getShareMetadataMock,
}))

vi.mock('$lib/server/require-user.js', () => ({
  requireUser: () => ({ userId: 'recipient-1', orgRole: 'member' }),
}))

import { ApiClientError } from '$lib/api/client.js'
import { load } from './+page.server.js'

const token = 'raw-token-value'

function makeEvent() {
  return {
    params: { token },
    fetch: vi.fn(),
    locals: { user: { userId: 'recipient-1', orgRole: 'member' } },
  } as unknown as Parameters<typeof load>[0]
}

describe('/shares/[token] +page.server.ts', () => {
  beforeEach(() => {
    getShareMetadataMock.mockReset()
  })

  it('AC-8: returns share metadata (never the value) on a valid token', async () => {
    getShareMetadataMock.mockResolvedValue({
      credentialId: 'cred-1',
      credentialName: 'Stripe Secret Key',
      sharedBy: 'sharer-1',
      sharedByEmail: 'morgan@example.com',
      fieldKey: null,
      expiresAt: '2026-08-01T00:00:00.000Z',
      singleUse: true,
      status: 'active',
    })

    const result = await load(makeEvent())

    expect(result.metadata?.credentialName).toBe('Stripe Secret Key')
    expect(result.error).toBeNull()
    expect(getShareMetadataMock).toHaveBeenCalledWith(expect.anything(), token)
  })

  it('AC-7: a not-found token renders an honest not_found state', async () => {
    getShareMetadataMock.mockRejectedValue(new ApiClientError(404, null, 'not found'))

    const result = await load(makeEvent())

    expect(result.metadata).toBeNull()
    expect(result.error).toBe('not_found')
  })

  it('AC-7: a session-mismatched token renders a 403-derived session_mismatch state, not a generic error', async () => {
    getShareMetadataMock.mockRejectedValue(
      new ApiClientError(403, { code: 'share_recipient_mismatch' }, 'mismatch')
    )

    const result = await load(makeEvent())

    expect(result.metadata).toBeNull()
    expect(result.error).toBe('session_mismatch')
  })

  it('rethrows an unexpected error', async () => {
    getShareMetadataMock.mockRejectedValue(new Error('boom'))

    await expect(load(makeEvent())).rejects.toThrow('boom')
  })
})
