import { describe, expect, it, vi } from 'vitest'
import { ApiClientError } from './client.js'
import {
  linkExternalIdentity,
  listExternalIdentities,
  unlinkExternalIdentity,
} from './external-identities.js'
import { jsonResponse } from '$lib/test/json-response.js'

const IDENTITY_ID = '00000000-0000-4000-8000-000000000001'
const USER_ID = '00000000-0000-4000-8000-000000000002'
const ROW = {
  id: IDENTITY_ID,
  userId: USER_ID,
  email: 'alex@acme.com',
  providerName: 'test.mock-sso-extension',
  externalSubject: 'alex-sso-subject-123',
  createdAt: '2026-07-28T14:03:11.000Z',
}

describe('external-identities API helpers', () => {
  it('listExternalIdentities returns the envelope data array', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: [ROW] }))

    const result = await listExternalIdentities(fetchFn)

    expect(fetchFn).toHaveBeenCalledWith(
      '/api/v1/admin/external-identities',
      expect.objectContaining({})
    )
    expect(result).toEqual([ROW])
  })

  it('linkExternalIdentity posts to the collection endpoint', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: ROW }))

    const result = await linkExternalIdentity(fetchFn, {
      userId: USER_ID,
      providerName: 'test.mock-sso-extension',
      externalSubject: 'alex-sso-subject-123',
    })

    expect(fetchFn).toHaveBeenCalledWith(
      '/api/v1/admin/external-identities',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          userId: USER_ID,
          providerName: 'test.mock-sso-extension',
          externalSubject: 'alex-sso-subject-123',
        }),
      })
    )
    expect(result).toEqual(ROW)
  })

  it('linkExternalIdentity surfaces a 409 conflict as a catchable ApiClientError', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(
          { code: 'conflict', message: 'This external identity is already linked' },
          { status: 409 }
        )
      )

    await expect(
      linkExternalIdentity(fetchFn, {
        userId: USER_ID,
        providerName: 'p',
        externalSubject: 's',
      })
    ).rejects.toMatchObject({
      status: 409,
      code: 'conflict',
    } satisfies Partial<ApiClientError>)
  })

  it('linkExternalIdentity surfaces a 404 user_not_found as a catchable ApiClientError', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ code: 'user_not_found', message: 'User not found' }, { status: 404 })
      )

    await expect(
      linkExternalIdentity(fetchFn, { userId: USER_ID, providerName: 'p', externalSubject: 's' })
    ).rejects.toMatchObject({
      status: 404,
      code: 'user_not_found',
    } satisfies Partial<ApiClientError>)
  })

  it('unlinkExternalIdentity issues a DELETE to the item endpoint', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: { id: IDENTITY_ID } }))

    const result = await unlinkExternalIdentity(fetchFn, IDENTITY_ID)

    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/admin/external-identities/${IDENTITY_ID}`,
      expect.objectContaining({ method: 'DELETE' })
    )
    expect(result).toEqual({ id: IDENTITY_ID })
  })

  it('unlinkExternalIdentity surfaces a 404 not_found as a catchable ApiClientError', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ code: 'not_found', message: 'External identity not found' }, { status: 404 })
      )

    await expect(unlinkExternalIdentity(fetchFn, IDENTITY_ID)).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    } satisfies Partial<ApiClientError>)
  })
})
