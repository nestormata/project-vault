// Story 69.6: a contribution `load` at `project.certificates.list-header`. PV skips every contribution
// load when its own project layout answered `notFound` (a foreign or unknown project id), so another
// org's project id never reaches here. The load reads the project through the caller's own session
// and the org's project ids through the pack's module route (RLS applies); both tolerate a non-JSON
// answer instead of turning the page into a 500.
export const load = async ({
  fetch,
  params,
}: {
  fetch: typeof globalThis.fetch
  params: { projectId?: string }
}) => {
  const project = await fetch(`/api/v1/projects/${encodeURIComponent(params.projectId ?? '')}`)
  const documents = await fetch('/api/v1/cm/documents')
  const body = (await documents.json().catch(() => ({}))) as {
    data?: { visibleProjectIds?: string[] }
  }
  return {
    projectStatus: project.status,
    projects: body.data?.visibleProjectIds?.length ?? 0,
  }
}
