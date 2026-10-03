import { requireUser } from '$lib/server/require-user.js'

/** The load of a "create something in this project" page (new certificate, credential, domain,
 * machine user, service endpoint, service): the project id and the viewer's org role. Six pages
 * returned exactly this inline. */
export function projectFormPageLoad({
  params,
  locals,
}: {
  params: { projectId: string }
  locals: App.Locals
}) {
  return { projectId: params.projectId, orgRole: requireUser(locals).orgRole }
}
