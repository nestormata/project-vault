// A contribution `load` at `project.members.access` (Story 69.4). Since Story 69.7 PV's own load marks
// a foreign or nonexistent project id as denied, so this load does NOT run for such a request (the
// fill renders `status=none`). When it does run it reads the project through the caller's own
// session: the real API answers another org's id exactly like a nonexistent one (404).
// `runs` counts the loads this server process ran: a caller PV flagged as denied on this page (a
// foreign or unknown project id, Story 69.7) never moves it (DW-535 b).
let runs = 0

export const load = async ({
  fetch,
  params,
}: {
  fetch: typeof globalThis.fetch
  params: { projectId?: string }
}) => {
  runs += 1
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(params.projectId ?? '')}`)
  return {
    marker: 'mock-ui-pack:m3-p5-project.members.access',
    projectStatus: response.status,
    runs,
  }
}
