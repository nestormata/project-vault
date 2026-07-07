import { apiFetch } from './client.js'
import type { SecurityAlertItem } from '$lib/notifications/dormancy-alerts.js'

export type ListOrgSecurityAlertsQuery = {
  status?: 'PENDING_DELIVERY' | 'delivered' | 'dismissed' | 'all'
}

export type ListOrgSecurityAlertsResponse = {
  items: SecurityAlertItem[]
  total: number
  page: number
  limit: number
  hasNext: boolean
}

export function listOrgSecurityAlerts(
  fetchFn: typeof fetch,
  query: ListOrgSecurityAlertsQuery = {}
) {
  const params = new URLSearchParams()
  if (query.status) params.set('status', query.status)
  const suffix = params.size > 0 ? `?${params.toString()}` : ''
  return apiFetch<ListOrgSecurityAlertsResponse>(fetchFn, `/api/v1/org/security-alerts${suffix}`)
}

// D9/AC-22's generic dismiss endpoint (not the org-prefixed 6.2 one) — the one built specifically
// to be reused by any inbox surface for any alertType, matching this AC's own wording.
export function dismissSecurityAlert(fetchFn: typeof fetch, alertId: string, reason: string) {
  return apiFetch<{ id: string; status: 'dismissed' }>(
    fetchFn,
    `/api/v1/security-alerts/${alertId}/dismiss`,
    { method: 'POST', body: JSON.stringify({ reason }) }
  )
}
