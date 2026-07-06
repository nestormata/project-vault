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

export async function listServiceEndpoints(
  fetchFn: typeof fetch,
  projectId: string
): Promise<ServiceEndpoint[]> {
  const { items } = await apiFetch<{ items: ServiceEndpoint[] }>(
    fetchFn,
    `/api/v1/projects/${projectId}/service-endpoints`
  )
  return items
}
