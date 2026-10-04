// Story 69.1: a contribution `load` at the region point `project.detail.tiles`, run by PV through the
// host route's behavior table (the pack opted in with `hostRoutes`). It runs with the SAME
// RequestEvent as PV's own load (the member's own session, the same `event.fetch`), reads the project
// through the authenticated API (so the API's RLS applies to it) and returns ids and a status only:
// the result is serialized into the page and `__data.json`, so it never holds a secret.
export const load = async ({
  fetch,
  params,
}: {
  fetch: typeof globalThis.fetch
  params: { projectId?: string }
}) => {
  const projectId = params.projectId ?? ''
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}`)
  return { projectId, apiStatus: response.status }
}
