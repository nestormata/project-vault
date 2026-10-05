// Story 69.3: a contribution `load` at the region point `project.status-page.services`, run through
// the status page admin route's behavior table (the pack opted in with `hostRoutes`). It reads the
// project's status page configuration through the authenticated API with the member's own session
// and returns the project id and the API status ONLY: the configuration holds the bearer token of
// the public page, so nothing from the response body may be returned (the result is serialized into
// the page and `__data.json`).
export const load = async ({
  fetch,
  params,
}: {
  fetch: typeof globalThis.fetch
  params: { projectId?: string }
}) => {
  const projectId = params.projectId ?? ''
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/status-page`)
  return { projectId, apiStatus: response.status }
}
