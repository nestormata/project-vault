// Story 69.3: a contribution `load` at the region point `project.service-endpoints-detail.history`,
// run by PV through the host route's behavior table (the pack opted in with `hostRoutes`). It runs
// with the SAME RequestEvent as PV's own load (the member's own session, the same `event.fetch`),
// reads the endpoint through the authenticated API (so the API's RLS applies to it) and returns ids
// and a status only: the result is serialized into the page and `__data.json`, never a secret.
export const load = async ({
  fetch,
  params,
}: {
  fetch: typeof globalThis.fetch
  params: { projectId?: string; serviceEndpointId?: string }
}) => {
  const projectId = params.projectId ?? ''
  const serviceEndpointId = params.serviceEndpointId ?? ''
  const response = await fetch(
    `/api/v1/projects/${encodeURIComponent(projectId)}/service-endpoints/${encodeURIComponent(serviceEndpointId)}`
  )
  return { projectId, serviceEndpointId, apiStatus: response.status }
}
