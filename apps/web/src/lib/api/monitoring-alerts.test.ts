import { describe, expect, it, vi } from 'vitest'
import { jsonResponse } from '$lib/test/json-response.js'
import { dismissAlert, listAlerts, snoozeAlert } from './monitoring-alerts.js'

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const alertId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const sampleAlert = {
  id: alertId,
  alertType: 'service.down' as const,
  severity: 'critical' as const,
  status: 'active' as const,
  episodeKey: 'ep-1',
  serviceEndpointId: 'ep-endpoint-1',
  snoozedUntil: null,
  dismissedBy: null,
  dismissedAt: null,
  createdAt: '2026-07-01T00:00:00.000Z',
}

describe('monitoring-alerts API wrapper (Story 6.4 AC-F)', () => {
  it('listAlerts requests the given status filter and paginates', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        data: { items: [sampleAlert], page: 1, limit: 50, total: 1, hasNext: false },
      })
    )
    const result = await listAlerts(fetchFn, projectId, { status: 'active' })
    const [url] = fetchFn.mock.calls[0] ?? []
    expect(url).toContain(`/api/v1/projects/${projectId}/alerts`)
    expect(url).toContain('status=active')
    expect(result.items).toEqual([sampleAlert])
  })

  it('listAlerts omits the status query param when not given (fetch-unfiltered-and-filter-client-side path)', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ data: { items: [], page: 1, limit: 50, total: 0, hasNext: false } })
      )
    await listAlerts(fetchFn, projectId, {})
    const [url] = fetchFn.mock.calls[0] ?? []
    expect(url).not.toContain('status=')
  })

  it('snoozeAlert POSTs durationMinutes', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: { ...sampleAlert, status: 'snoozed' } }))
    await snoozeAlert(fetchFn, projectId, alertId, { durationMinutes: 60 })
    const [url, init] = fetchFn.mock.calls[0] ?? []
    expect(url).toBe(`/api/v1/projects/${projectId}/alerts/${alertId}/snooze`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ durationMinutes: 60 })
  })

  it('dismissAlert POSTs with no body', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: { ...sampleAlert, status: 'dismissed' } }))
    await dismissAlert(fetchFn, projectId, alertId)
    const [url, init] = fetchFn.mock.calls[0] ?? []
    expect(url).toBe(`/api/v1/projects/${projectId}/alerts/${alertId}/dismiss`)
    expect(init.method).toBe('POST')
  })
})
