import { apiFetch } from './client.js'

// Story 6.2 shipped this endpoint API-only (no web UI consumer yet); ServiceEndpointSchema lives
// in apps/api/src/modules/monitoring/schema.ts, not packages/shared, so this plain TS type is
// declared locally here (mirrors org-users.ts's ProjectMember convention for the same reason).
export type ServiceEndpointStatus = 'healthy' | 'degraded' | 'down'

export type ServiceEndpoint = {
  id: string
  name: string
  url: string
  status: ServiceEndpointStatus
  lastCheckedAt: string | null
}

// Story 6.4 (Task 2): the full record shape used by the new create/edit/detail pages — a
// superset of the trimmed `ServiceEndpoint` shape above that the status-page picker already
// consumed.

// Mirrors apps/api/src/modules/monitoring/schema.ts's CHECK_FREQUENCY_MINUTES exactly (AC-E3).
// apps/web has no dependency on apps/api (only on @project-vault/shared, see package.json), so
// this constant cannot be imported across the app boundary and is intentionally re-declared here
// — the same "declared locally" pattern already used above for ServiceEndpoint/ServiceEndpointStatus,
// which live in apps/api's schema rather than packages/shared for the same reason.
export const CHECK_FREQUENCY_MINUTES = [1, 5, 15, 30] as const
export type ServiceEndpointDetail = {
  id: string
  orgId: string
  projectId: string
  name: string
  url: string
  checkFrequencyMinutes: number
  downThresholdFailures: number
  status: ServiceEndpointStatus
  consecutiveFailures: number
  lastCheckedAt: string | null
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

export type CreateServiceEndpointRequest = {
  name: string
  url: string
  checkFrequencyMinutes?: number
  downThresholdFailures?: number
}

export type UpdateServiceEndpointRequest = {
  name?: string
  url?: string
  checkFrequencyMinutes?: number
  downThresholdFailures?: number
}

export type HealthHistoryFailureReason = 'timeout' | 'http_error' | 'network_error' | 'ssrf_blocked'

export type HealthHistoryEntry = {
  isHealthy: boolean
  statusCode: number | null
  latencyMs: number
  failureReason: HealthHistoryFailureReason | null
  checkedAt: string
}

export type HealthHistoryQuery = {
  page?: number
  limit?: number
}

export type HealthHistoryResponse = {
  items: HealthHistoryEntry[]
  page: number
  limit: number
  total: number
  hasNext: boolean
}

function serviceEndpointUrl(projectId: string, serviceEndpointId?: string): string {
  const idSuffix = serviceEndpointId ? `/${serviceEndpointId}` : ''
  return `/api/v1/projects/${projectId}/service-endpoints${idSuffix}`
}

export async function listServiceEndpoints(
  fetchFn: typeof fetch,
  projectId: string
): Promise<ServiceEndpoint[]> {
  const { items } = await apiFetch<{ items: ServiceEndpoint[] }>(
    fetchFn,
    serviceEndpointUrl(projectId)
  )
  return items
}

// Story 6.4 (AC-E2): the new list page needs checkFrequencyMinutes/downThresholdFailures, which
// the trimmed `listServiceEndpoints`/`ServiceEndpoint` shape (built for the Story 6.3 status-page
// picker) doesn't carry. Same endpoint, richer typed projection — no second network shape.
export async function listServiceEndpointDetails(
  fetchFn: typeof fetch,
  projectId: string
): Promise<ServiceEndpointDetail[]> {
  const { items } = await apiFetch<{ items: ServiceEndpointDetail[] }>(
    fetchFn,
    serviceEndpointUrl(projectId)
  )
  return items
}

export function getServiceEndpoint(
  fetchFn: typeof fetch,
  projectId: string,
  serviceEndpointId: string
) {
  return apiFetch<ServiceEndpointDetail>(fetchFn, serviceEndpointUrl(projectId, serviceEndpointId))
}

export function createServiceEndpoint(
  fetchFn: typeof fetch,
  projectId: string,
  body: CreateServiceEndpointRequest
) {
  return apiFetch<ServiceEndpointDetail>(fetchFn, serviceEndpointUrl(projectId), {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function updateServiceEndpoint(
  fetchFn: typeof fetch,
  projectId: string,
  serviceEndpointId: string,
  body: UpdateServiceEndpointRequest
) {
  return apiFetch<ServiceEndpointDetail>(
    fetchFn,
    serviceEndpointUrl(projectId, serviceEndpointId),
    {
      method: 'PATCH',
      body: JSON.stringify(body),
    }
  )
}

export function deleteServiceEndpoint(
  fetchFn: typeof fetch,
  projectId: string,
  serviceEndpointId: string
) {
  return apiFetch<undefined>(fetchFn, serviceEndpointUrl(projectId, serviceEndpointId), {
    method: 'DELETE',
  })
}

export function getHealthHistory(
  fetchFn: typeof fetch,
  projectId: string,
  serviceEndpointId: string,
  query: HealthHistoryQuery = {}
) {
  const params = new URLSearchParams()
  if (query.page !== undefined) params.set('page', String(query.page))
  if (query.limit !== undefined) params.set('limit', String(query.limit))
  const querySuffix = params.size > 0 ? `?${params.toString()}` : ''
  return apiFetch<HealthHistoryResponse>(
    fetchFn,
    `${serviceEndpointUrl(projectId, serviceEndpointId)}/health-history${querySuffix}`
  )
}
