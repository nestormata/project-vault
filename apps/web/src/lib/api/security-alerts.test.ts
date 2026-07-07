import { describe, expect, it, vi } from 'vitest'
import { jsonResponse } from '$lib/test/json-response.js'
import { dismissSecurityAlert, listOrgSecurityAlerts } from './security-alerts.js'

describe('security-alerts API helpers (AC-4)', () => {
  it('listOrgSecurityAlerts GETs the org-scoped list endpoint with an optional status filter', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ data: { items: [], total: 0, page: 1, limit: 20, hasNext: false } })
      )
    await listOrgSecurityAlerts(fetchFn, { status: 'all' })
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/v1/org/security-alerts?status=all',
      expect.objectContaining({ credentials: 'include' })
    )
  })

  it('listOrgSecurityAlerts omits the query string when no status is given', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ data: { items: [], total: 0, page: 1, limit: 20, hasNext: false } })
      )
    await listOrgSecurityAlerts(fetchFn)
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/v1/org/security-alerts',
      expect.objectContaining({ credentials: 'include' })
    )
  })

  it('dismissSecurityAlert POSTs the required reason to the generic dismiss endpoint', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: { id: 'alert-1', status: 'dismissed' } }))
    await dismissSecurityAlert(fetchFn, 'alert-1', 'no longer relevant')
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/v1/security-alerts/alert-1/dismiss',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ reason: 'no longer relevant' }),
      })
    )
  })
})
