import { describe, expect, it, vi } from 'vitest'
import { jsonResponse } from '$lib/test/json-response.js'
import {
  createService,
  deleteService,
  getService,
  listServices,
  updateService,
} from './services.js'

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const serviceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const sampleService = {
  id: serviceId,
  orgId: 'org-1',
  projectId,
  name: 'AWS Hosting',
  url: 'https://console.aws.amazon.com/billing',
  renewalDate: '2026-09-01T00:00:00.000Z',
  alertLeadDays: [14, 3],
  notifiedLeadDays: [],
  createdBy: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

describe('services API wrapper (Story 6.4 AC-B, payment_records)', () => {
  it('listServices calls GET /services and unwraps items', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: { items: [sampleService] } }))
    const result = await listServices(fetchFn, projectId)
    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/services`,
      expect.objectContaining({ credentials: 'include' })
    )
    expect(result).toEqual([sampleService])
  })

  it('getService calls GET /services/:id', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: sampleService }))
    const result = await getService(fetchFn, projectId, serviceId)
    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/services/${serviceId}`,
      expect.anything()
    )
    expect(result).toEqual(sampleService)
  })

  it('createService POSTs the full create body including optional fields', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: sampleService }, { status: 201 }))
    await createService(fetchFn, projectId, {
      name: 'AWS Hosting',
      url: 'https://console.aws.amazon.com/billing',
      renewalDate: '2026-09-01T00:00:00.000Z',
    })
    const [url, init] = fetchFn.mock.calls[0] ?? []
    expect(url).toBe(`/api/v1/projects/${projectId}/services`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({
      name: 'AWS Hosting',
      url: 'https://console.aws.amazon.com/billing',
      renewalDate: '2026-09-01T00:00:00.000Z',
    })
  })

  it('createService omits optional fields entirely when left blank (AC-B3 edge: name-only)', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: sampleService }, { status: 201 }))
    await createService(fetchFn, projectId, { name: 'GitHub SaaS seat' })
    const [, init] = fetchFn.mock.calls[0] ?? []
    expect(JSON.parse(init.body)).toEqual({ name: 'GitHub SaaS seat' })
  })

  it('updateService PATCHes only url/renewalDate/alertLeadDays — never name (AC-B4)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: sampleService }))
    await updateService(fetchFn, projectId, serviceId, { renewalDate: '2027-01-01T00:00:00.000Z' })
    const [url, init] = fetchFn.mock.calls[0] ?? []
    expect(url).toBe(`/api/v1/projects/${projectId}/services/${serviceId}`)
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body)).toEqual({ renewalDate: '2027-01-01T00:00:00.000Z' })
    expect(JSON.parse(init.body)).not.toHaveProperty('name')
  })

  it('deleteService calls DELETE and resolves with no body (204)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    const result = await deleteService(fetchFn, projectId, serviceId)
    const [url, init] = fetchFn.mock.calls[0] ?? []
    expect(url).toBe(`/api/v1/projects/${projectId}/services/${serviceId}`)
    expect(init.method).toBe('DELETE')
    expect(result).toBeUndefined()
  })
})
