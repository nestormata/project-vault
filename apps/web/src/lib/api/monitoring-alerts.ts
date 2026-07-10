import { apiFetch } from './client.js'

export type MonitoringAlertStatus = 'active' | 'snoozed' | 'dismissed' | 'resolved_by_deletion'

export type MonitoringAlert = {
  id: string
  alertType: 'service.down' | 'service.recovery'
  severity: 'info' | 'warning' | 'critical'
  status: MonitoringAlertStatus
  episodeKey: string
  // Background: can be null — a historical alert whose originating endpoint was later deleted.
  serviceEndpointId: string | null
  snoozedUntil: string | null
  dismissedBy: string | null
  dismissedAt: string | null
  createdAt: string
}

export type ListAlertsQuery = {
  status?: MonitoringAlertStatus
  serviceEndpointId?: string
  page?: number
  limit?: number
}

export type ListAlertsResponse = {
  items: MonitoringAlert[]
  page: number
  limit: number
  total: number
  hasNext: boolean
}

function alertsUrl(projectId: string): string {
  return `/api/v1/projects/${projectId}/alerts`
}

export function listAlerts(fetchFn: typeof fetch, projectId: string, query: ListAlertsQuery = {}) {
  const params = new URLSearchParams()
  if (query.status) params.set('status', query.status)
  if (query.serviceEndpointId) params.set('serviceEndpointId', query.serviceEndpointId)
  if (query.page !== undefined) params.set('page', String(query.page))
  if (query.limit !== undefined) params.set('limit', String(query.limit))
  const serialized = params.toString()
  const querySuffix = serialized ? `?${serialized}` : ''
  return apiFetch<ListAlertsResponse>(fetchFn, `${alertsUrl(projectId)}${querySuffix}`)
}

export function snoozeAlert(
  fetchFn: typeof fetch,
  projectId: string,
  alertId: string,
  body: { durationMinutes: number }
) {
  return apiFetch<MonitoringAlert>(fetchFn, `${alertsUrl(projectId)}/${alertId}/snooze`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

// Background/ADR-6.2-04: dismiss requires admin+ role server-side; the UI's role gate must check
// canDismissAlert specifically (see $lib/monitoring/permissions.ts), not the member+ gate used
// for every other mutation in this module.
export function dismissAlert(fetchFn: typeof fetch, projectId: string, alertId: string) {
  return apiFetch<MonitoringAlert>(fetchFn, `${alertsUrl(projectId)}/${alertId}/dismiss`, {
    method: 'POST',
  })
}
