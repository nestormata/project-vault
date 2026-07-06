import { describe, expect, it, vi } from 'vitest'
import { jsonResponse } from '$lib/test/json-response.js'
import {
  createServiceEndpoint,
  deleteServiceEndpoint,
  getHealthHistory,
  getServiceEndpoint,
  listServiceEndpointDetails,
  listServiceEndpoints,
  updateServiceEndpoint,
} from './service-endpoints.js'

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const serviceEndpointId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const sampleEndpoint = {
  id: serviceEndpointId,
  orgId: 'org-1',
  projectId,
  name: 'API health',
  url: 'https://api.example.com/health',
  checkFrequencyMinutes: 5,
  downThresholdFailures: 2,
  status: 'healthy' as const,
  consecutiveFailures: 0,
  lastCheckedAt: null,
  createdBy: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

describe('service-endpoints API wrapper extension (Story 6.4 AC-E)', () => {
  it('listServiceEndpoints still unwraps items (pre-existing Story 6.2 behavior)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ items: [sampleEndpoint] }))
    const result = await listServiceEndpoints(fetchFn, projectId)
    expect(result).toEqual([sampleEndpoint])
  })

  it('listServiceEndpointDetails unwraps the full record shape (AC-E2, checkFrequencyMinutes/downThresholdFailures)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: { items: [sampleEndpoint] } }))
    const result = await listServiceEndpointDetails(fetchFn, projectId)
    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/service-endpoints`,
      expect.objectContaining({ credentials: 'include' })
    )
    expect(result).toEqual([sampleEndpoint])
  })

  it('getServiceEndpoint calls GET /service-endpoints/:id', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: sampleEndpoint }))
    const result = await getServiceEndpoint(fetchFn, projectId, serviceEndpointId)
    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/service-endpoints/${serviceEndpointId}`,
      expect.anything()
    )
    expect(result).toEqual(sampleEndpoint)
  })

  it('createServiceEndpoint POSTs name/url plus optional frequency/threshold', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: sampleEndpoint }, { status: 201 }))
    await createServiceEndpoint(fetchFn, projectId, {
      name: 'API health',
      url: 'https://api.example.com/health',
      checkFrequencyMinutes: 1,
      downThresholdFailures: 1,
    })
    const [url, init] = fetchFn.mock.calls[0] ?? []
    expect(url).toBe(`/api/v1/projects/${projectId}/service-endpoints`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({
      name: 'API health',
      url: 'https://api.example.com/health',
      checkFrequencyMinutes: 1,
      downThresholdFailures: 1,
    })
  })

  it('updateServiceEndpoint PATCHes only the changed fields, e.g. url alone (AC-E4 re-URL)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: sampleEndpoint }))
    await updateServiceEndpoint(fetchFn, projectId, serviceEndpointId, {
      url: 'https://api.example.com/healthz',
    })
    const [url, init] = fetchFn.mock.calls[0] ?? []
    expect(url).toBe(`/api/v1/projects/${projectId}/service-endpoints/${serviceEndpointId}`)
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body)).toEqual({ url: 'https://api.example.com/healthz' })
  })

  it('deleteServiceEndpoint calls DELETE', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    await deleteServiceEndpoint(fetchFn, projectId, serviceEndpointId)
    const [url, init] = fetchFn.mock.calls[0] ?? []
    expect(url).toBe(`/api/v1/projects/${projectId}/service-endpoints/${serviceEndpointId}`)
    expect(init.method).toBe('DELETE')
  })

  it('getHealthHistory paginates via page/limit query params (AC-E6)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          items: [
            {
              isHealthy: true,
              statusCode: 200,
              latencyMs: 120,
              failureReason: null,
              checkedAt: '2026-07-01T00:00:00.000Z',
            },
          ],
          page: 2,
          limit: 50,
          total: 60,
          hasNext: false,
        },
      })
    )
    const result = await getHealthHistory(fetchFn, projectId, serviceEndpointId, { page: 2 })
    const [url] = fetchFn.mock.calls[0] ?? []
    expect(url).toContain(
      `/api/v1/projects/${projectId}/service-endpoints/${serviceEndpointId}/health-history`
    )
    expect(url).toContain('page=2')
    expect(result.items).toHaveLength(1)
    expect(result.page).toBe(2)
  })
})
