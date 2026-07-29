import { describe, expect, it, vi } from 'vitest'
import {
  createCredentialShare,
  createExternalCredentialShare,
  getExternalShareMetadata,
  getShareMetadata,
  listCredentialShares,
  revealCredentialShare,
  revealExternalCredentialShare,
  revokeCredentialShare,
} from './credential-shares.js'
import { jsonResponse } from '$lib/test/json-response.js'

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const credentialId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const shareId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const token = 'ltw_someOpaqueToken'

const sampleShare = {
  id: shareId,
  credentialId,
  fieldKey: null,
  sharedBy: 'user-1',
  recipientType: 'user' as const,
  recipientUserId: 'user-2',
  recipientEmail: null,
  singleUse: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-01-02T00:00:00.000Z',
  revokedAt: null,
  firstViewedAt: null,
  viewCount: 0,
  status: 'active' as const,
}

describe('credential-shares API wrapper (Story 17.1)', () => {
  it('listCredentialShares unwraps items from GET .../shares', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: { items: [sampleShare] } }))
    const result = await listCredentialShares(fetchFn, projectId, credentialId)
    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/credentials/${credentialId}/shares`,
      expect.objectContaining({ credentials: 'include' })
    )
    expect(result).toEqual({ items: [sampleShare] })
  })

  it('createCredentialShare POSTs the request body and returns the one-time token (AC-1/AC-4)', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: { ...sampleShare, token } }, { status: 201 }))
    const body = {
      recipientUserId: 'user-2',
      expiresAt: '2026-01-02T00:00:00.000Z',
      singleUse: true,
    }
    const result = await createCredentialShare(fetchFn, projectId, credentialId, body)
    const [url, init] = fetchFn.mock.calls[0] ?? []
    expect(url).toBe(`/api/v1/projects/${projectId}/credentials/${credentialId}/shares`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual(body)
    expect(result.token).toBe(token)
  })

  it('revokeCredentialShare POSTs to .../shares/:shareId/revoke (AC-5)', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: { ...sampleShare, status: 'revoked' } }))
    const result = await revokeCredentialShare(fetchFn, projectId, credentialId, shareId)
    const [url, init] = fetchFn.mock.calls[0] ?? []
    expect(url).toBe(
      `/api/v1/projects/${projectId}/credentials/${credentialId}/shares/${shareId}/revoke`
    )
    expect(init.method).toBe('POST')
    expect(result.status).toBe('revoked')
  })

  it('getShareMetadata calls GET /shares/access/:token, addressed by token not project/credential (AC-7)', async () => {
    const metadata = {
      credentialId,
      credentialName: 'Stripe API Key',
      sharedBy: 'user-1',
      sharedByEmail: 'morgan@example.com',
      fieldKey: null,
      expiresAt: '2026-01-02T00:00:00.000Z',
      singleUse: true,
      status: 'active' as const,
    }
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: metadata }))
    const result = await getShareMetadata(fetchFn, token)
    expect(fetchFn).toHaveBeenCalledWith(`/api/v1/shares/access/${token}`, expect.anything())
    expect(result).toEqual(metadata)
  })

  it('revealCredentialShare POSTs to /shares/access/:token/reveal (AC-8)', async () => {
    const revealResult = {
      credentialId,
      fieldKey: null,
      value: 'sk_live_example',
      viewedAt: '2026-01-01T00:05:00.000Z',
    }
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: revealResult }))
    const result = await revealCredentialShare(fetchFn, token)
    const [url, init] = fetchFn.mock.calls[0] ?? []
    expect(url).toBe(`/api/v1/shares/access/${token}/reveal`)
    expect(init.method).toBe('POST')
    expect(result).toEqual(revealResult)
  })

  it('createExternalCredentialShare POSTs to .../external-shares with the step-up factor (Story 17.2 AC-1/AC-3)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          data: {
            ...sampleShare,
            recipientType: 'external',
            recipientUserId: null,
            recipientEmail: 'priya@vendor.example',
            token,
          },
        },
        { status: 201 }
      )
    )
    const body = {
      recipientEmail: 'priya@vendor.example',
      expiresAt: '2026-01-02T00:00:00.000Z',
      password: 'my-password',
    }
    const result = await createExternalCredentialShare(fetchFn, projectId, credentialId, body)
    const [url, init] = fetchFn.mock.calls[0] ?? []
    expect(url).toBe(`/api/v1/projects/${projectId}/credentials/${credentialId}/external-shares`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual(body)
    expect(result.recipientType).toBe('external')
    expect(result.token).toBe(token)
  })

  it('getExternalShareMetadata calls GET /external-shares/access/:token (Story 17.2 AC-9)', async () => {
    const metadata = {
      credentialId,
      credentialName: 'Stripe API Key',
      sharedByDisplayName: 'morgan',
      fieldKey: null,
      expiresAt: '2026-01-02T00:00:00.000Z',
      status: 'active' as const,
    }
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: metadata }))
    const result = await getExternalShareMetadata(fetchFn, token)
    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/external-shares/access/${token}`,
      expect.anything()
    )
    expect(result).toEqual(metadata)
  })

  it('revealExternalCredentialShare POSTs to /external-shares/access/:token/reveal (Story 17.2 AC-8)', async () => {
    const revealResult = {
      credentialId,
      fieldKey: null,
      value: 'sk_live_example',
      viewedAt: '2026-01-01T00:05:00.000Z',
    }
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: revealResult }))
    const result = await revealExternalCredentialShare(fetchFn, token)
    const [url, init] = fetchFn.mock.calls[0] ?? []
    expect(url).toBe(`/api/v1/external-shares/access/${token}/reveal`)
    expect(init.method).toBe('POST')
    expect(result).toEqual(revealResult)
  })
})
