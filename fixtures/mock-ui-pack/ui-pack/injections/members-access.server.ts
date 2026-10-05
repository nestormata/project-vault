// A contribution `load` at `project.members.access` (Story 69.4). PV's own load degrades a foreign
// or nonexistent project id to empty lists (no throw), so this load DOES run for such a request. It
// reads the project through the caller's own session: the real API answers another org's id exactly
// like a nonexistent one (404), and the status is all this returns.
export const load = async ({
  fetch,
  params,
}: {
  fetch: typeof globalThis.fetch
  params: { projectId?: string }
}) => {
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(params.projectId ?? '')}`)
  return {
    marker: 'mock-ui-pack:m3-p5-project.members.access',
    projectStatus: response.status,
  }
}
