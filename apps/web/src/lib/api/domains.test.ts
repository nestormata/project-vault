import { describe, expect, it, vi } from 'vitest'
import { createDomain, deleteDomain, getDomain, listDomains, updateDomain } from './domains.js'
import { jsonResponse } from '$lib/test/json-response.js'

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const domainId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const sampleDomain = {
  id: domainId,
  orgId: 'org-1',
  projectId,
  domainName: 'example.com',
  renewalDate: '2027-01-01T00:00:00.000Z',
  alertLeadDays: [30],
  notifiedLeadDays: [],
  createdBy: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

describe('domains API wrapper (Story 6.4 AC-D, domain_records)', () => {
  it('listDomains unwraps items from GET /domains', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: { items: [sampleDomain] } }))
    const result = await listDomains(fetchFn, projectId)
    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/domains`,
      expect.objectContaining({ credentials: 'include' })
    )
    expect(result).toEqual([sampleDomain])
  })

  it('getDomain calls GET /domains/:id', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: sampleDomain }))
    const result = await getDomain(fetchFn, projectId, domainId)
    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/domains/${domainId}`,
      expect.anything()
    )
    expect(result).toEqual(sampleDomain)
  })

  it('createDomain POSTs required domainName+renewalDate (both required per schema.ts)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: sampleDomain }, { status: 201 }))
    await createDomain(fetchFn, projectId, {
      domainName: 'example.com',
      renewalDate: '2027-01-01T00:00:00.000Z',
    })
    const [url, init] = fetchFn.mock.calls[0] ?? []
    expect(url).toBe(`/api/v1/projects/${projectId}/domains`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({
      domainName: 'example.com',
      renewalDate: '2027-01-01T00:00:00.000Z',
    })
  })

  it('updateDomain allows renaming domainName (AC-D1)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: sampleDomain }))
    await updateDomain(fetchFn, projectId, domainId, { domainName: 'example.org' })
    const [url, init] = fetchFn.mock.calls[0] ?? []
    expect(url).toBe(`/api/v1/projects/${projectId}/domains/${domainId}`)
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body)).toEqual({ domainName: 'example.org' })
  })

  it('deleteDomain calls DELETE', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    await deleteDomain(fetchFn, projectId, domainId)
    const [url, init] = fetchFn.mock.calls[0] ?? []
    expect(url).toBe(`/api/v1/projects/${projectId}/domains/${domainId}`)
    expect(init.method).toBe('DELETE')
  })
})
