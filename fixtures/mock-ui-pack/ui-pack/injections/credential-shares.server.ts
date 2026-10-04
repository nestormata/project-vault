// Story 69.2: a contribution `load` at the region point `credential.detail.shares`, run by PV through
// the host route's behavior table (the pack opted in with `hostRoutes`). It runs with the SAME
// RequestEvent as PV's own load (the member's own session, the same `event.fetch`), reads the
// credential through the authenticated API (so the API's RLS applies to it) and returns ids, a status
// and a per-load nonce only: the result is serialized into the page and `__data.json`.
export const load = async ({
  fetch,
  params,
}: {
  fetch: typeof globalThis.fetch
  params: { projectId?: string; credentialId?: string }
}) => {
  const projectId = params.projectId ?? ''
  const credentialId = params.credentialId ?? ''
  const response = await fetch(
    `/api/v1/projects/${encodeURIComponent(projectId)}/credentials/${encodeURIComponent(credentialId)}`
  )
  return { projectId, credentialId, apiStatus: response.status, nonce: crypto.randomUUID() }
}
