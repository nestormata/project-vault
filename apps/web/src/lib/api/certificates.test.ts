import { describe, expect, it, vi } from 'vitest'
import {
  createCertificate,
  deleteCertificate,
  getCertificate,
  listCertificates,
  updateCertificate,
} from './certificates.js'
import { jsonResponse } from '$lib/test/json-response.js'

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const certificateId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const sampleCertificate = {
  id: certificateId,
  orgId: 'org-1',
  projectId,
  domain: 'api.example.com',
  expiresAt: '2026-08-15T00:00:00.000Z',
  alertLeadDays: [30, 7],
  notifiedLeadDays: [],
  createdBy: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

describe('certificates API wrapper (Story 6.4 AC-C, cert_records)', () => {
  it('listCertificates unwraps items from GET /certificates', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: { items: [sampleCertificate] } }))
    const result = await listCertificates(fetchFn, projectId)
    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/certificates`,
      expect.objectContaining({ credentials: 'include' })
    )
    expect(result).toEqual([sampleCertificate])
  })

  it('getCertificate calls GET /certificates/:id', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: sampleCertificate }))
    const result = await getCertificate(fetchFn, projectId, certificateId)
    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/certificates/${certificateId}`,
      expect.anything()
    )
    expect(result).toEqual(sampleCertificate)
  })

  it('createCertificate POSTs required domain+expiresAt (both required per schema.ts)', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: sampleCertificate }, { status: 201 }))
    await createCertificate(fetchFn, projectId, {
      domain: 'api.example.com',
      expiresAt: '2026-08-15T00:00:00.000Z',
    })
    const [url, init] = fetchFn.mock.calls[0] ?? []
    expect(url).toBe(`/api/v1/projects/${projectId}/certificates`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({
      domain: 'api.example.com',
      expiresAt: '2026-08-15T00:00:00.000Z',
    })
  })

  it('updateCertificate allows renaming domain (unlike services, AC-C1 edge)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: sampleCertificate }))
    await updateCertificate(fetchFn, projectId, certificateId, { domain: 'api-v2.example.com' })
    const [url, init] = fetchFn.mock.calls[0] ?? []
    expect(url).toBe(`/api/v1/projects/${projectId}/certificates/${certificateId}`)
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body)).toEqual({ domain: 'api-v2.example.com' })
  })

  it('deleteCertificate calls DELETE', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    await deleteCertificate(fetchFn, projectId, certificateId)
    const [url, init] = fetchFn.mock.calls[0] ?? []
    expect(url).toBe(`/api/v1/projects/${projectId}/certificates/${certificateId}`)
    expect(init.method).toBe('DELETE')
  })
})
