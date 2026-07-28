import { describe, expect, it, vi } from 'vitest'
import { ApiClientError } from './client.js'
import {
  createOrgSsoDomain,
  deleteOrgSsoDomain,
  listOrgSsoDomains,
  updateOrgSsoDomain,
} from './org-sso-domains.js'
import { jsonResponse } from '$lib/test/json-response.js'

const DOMAIN_ID = '00000000-0000-4000-8000-000000000001'
const ROW = {
  id: DOMAIN_ID,
  domain: 'acme.com',
  providerName: 'test.mock-sso-extension',
  createdAt: '2026-07-27T12:00:00.000Z',
}

describe('org-sso-domains API helpers', () => {
  it('listOrgSsoDomains returns the envelope data array', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: [ROW] }))

    const result = await listOrgSsoDomains(fetchFn)

    expect(fetchFn).toHaveBeenCalledWith('/api/v1/org/sso-domains', expect.objectContaining({}))
    expect(result).toEqual([ROW])
  })

  it('createOrgSsoDomain posts to the collection endpoint', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: ROW }))

    const result = await createOrgSsoDomain(fetchFn, {
      domain: 'acme.com',
      providerName: 'test.mock-sso-extension',
    })

    expect(fetchFn).toHaveBeenCalledWith(
      '/api/v1/org/sso-domains',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ domain: 'acme.com', providerName: 'test.mock-sso-extension' }),
      })
    )
    expect(result).toEqual(ROW)
  })

  it('createOrgSsoDomain surfaces public_domain_blocked as a catchable ApiClientError', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(
          { code: 'public_domain_blocked', message: 'This domain is on our list...' },
          { status: 422 }
        )
      )

    await expect(
      createOrgSsoDomain(fetchFn, { domain: 'gmail.com', providerName: 'x' })
    ).rejects.toMatchObject({
      status: 422,
      code: 'public_domain_blocked',
    } satisfies Partial<ApiClientError>)
  })

  it('createOrgSsoDomain surfaces domain_already_mapped (409) as a catchable ApiClientError', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          code: 'domain_already_mapped',
          message: 'This domain is already mapped to an organization',
        },
        { status: 409 }
      )
    )

    await expect(
      createOrgSsoDomain(fetchFn, { domain: 'acme.com', providerName: 'x' })
    ).rejects.toMatchObject({
      status: 409,
      code: 'domain_already_mapped',
    } satisfies Partial<ApiClientError>)
  })

  it('updateOrgSsoDomain patches the item endpoint', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: ROW }))

    const result = await updateOrgSsoDomain(fetchFn, DOMAIN_ID, { providerName: 'other.provider' })

    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/org/sso-domains/${DOMAIN_ID}`,
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ providerName: 'other.provider' }),
      })
    )
    expect(result).toEqual(ROW)
  })

  it('deleteOrgSsoDomain issues a DELETE to the item endpoint', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: { id: DOMAIN_ID } }))

    const result = await deleteOrgSsoDomain(fetchFn, DOMAIN_ID)

    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/org/sso-domains/${DOMAIN_ID}`,
      expect.objectContaining({ method: 'DELETE' })
    )
    expect(result).toEqual({ id: DOMAIN_ID })
  })
})
