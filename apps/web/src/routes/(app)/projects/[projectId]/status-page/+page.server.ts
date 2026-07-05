import type { StatusPageConfig } from '@project-vault/shared'
import { listProjectMembers } from '$lib/api/org-users.js'
import { listServiceEndpoints, type ServiceEndpoint } from '$lib/api/service-endpoints.js'
import { getStatusPageConfig } from '$lib/api/status-page.js'
import { requireUser } from '$lib/server/require-user.js'
import type { PageServerLoad } from './$types.js'

// Story 6.3 ADR-6.3-07 (Task 9): gate the section in the UI on the SAME project-owner-or-org-owner
// condition as the backend — not project-owner alone. An org owner who isn't a project member
// still passes every backend authorization check, so the UI must check both axes too, or they
// would be unable to find this section. Server-side enforcement remains authoritative regardless.
export const load: PageServerLoad = async ({ params, fetch, locals }) => {
  const user = requireUser(locals)
  const isOrgOwner = user.orgRole === 'owner'

  let members: Awaited<ReturnType<typeof listProjectMembers>> = []
  try {
    members = await listProjectMembers(fetch, params.projectId)
  } catch {
    members = []
  }
  const selfMember = members.find((m) => m.userId === user.userId)
  const isProjectOwner = selfMember?.role === 'owner'
  const canManage = isProjectOwner || isOrgOwner

  let config: StatusPageConfig = { enabled: false }
  let serviceEndpoints: ServiceEndpoint[] = []
  if (canManage) {
    // AC 21 (realignment-review finding): pre-populates the section with the existing
    // configuration instead of always rendering an empty "never configured" form.
    ;[config, serviceEndpoints] = await Promise.all([
      getStatusPageConfig(fetch, params.projectId),
      listServiceEndpoints(fetch, params.projectId),
    ])
  }

  return {
    projectId: params.projectId,
    canManage,
    config,
    serviceEndpoints,
  }
}
