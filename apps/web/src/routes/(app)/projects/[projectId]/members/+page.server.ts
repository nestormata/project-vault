import {
  injectActions,
  SKIP_INJECTED_LOADS,
  withInjectedLoad,
} from '$lib/server/composition/inject-behavior.js'
import { ApiClientError } from '$lib/api/client.js'
import { listInvitations } from '$lib/api/invitations.js'
import { listProjectMembers, type ProjectMember } from '$lib/api/org-users.js'
import { requireUser } from '$lib/server/require-user.js'
import type { PageServerLoad } from './$types.js'

// The member list is authorized on the project-role axis (AC-10): a project admin/owner who is only
// an org member can still view/manage it, so we always attempt it and degrade to [].
// Story 69.7 (DW-531): a 403/404 here is PV's own denial (a project the caller cannot see), so the
// load carries the SKIP_INJECTED_LOADS marker and no contribution load runs. A 5xx or network failure
// is not a denial (a transient blip must not blank the composed product): [] without the marker.
async function loadMembers(
  fetch: Parameters<typeof listProjectMembers>[0],
  projectId: string
): Promise<{ members: ProjectMember[]; denied: boolean }> {
  try {
    return { members: await listProjectMembers(fetch, projectId), denied: false }
  } catch (err) {
    const denied = err instanceof ApiClientError && (err.status === 403 || err.status === 404)
    return { members: [], denied }
  }
}

const ownLoad = (async ({ params, fetch, locals }) => {
  const user = requireUser(locals)
  const orgRole = user.orgRole
  const isOrgAdminOrOwner = orgRole === 'owner' || orgRole === 'admin'

  let invitations: Awaited<ReturnType<typeof listInvitations>> = []
  if (isOrgAdminOrOwner) {
    try {
      invitations = await listInvitations(fetch, params.projectId)
    } catch {
      invitations = []
    }
  }

  const { members, denied } = await loadMembers(fetch, params.projectId)

  // Resolve the viewer's own project role (if any) to decide which actions to render.
  const selfMember = members.find((m) => m.userId === user.userId)
  const isProjectOwner = selfMember?.role === 'owner'
  const isProjectAdminOrOwner = selfMember?.role === 'admin' || isProjectOwner
  const canManageMembers = isProjectAdminOrOwner || isOrgAdminOrOwner
  const canTransferOwnership = isProjectOwner || orgRole === 'owner'

  return {
    projectId: params.projectId,
    userId: user.userId,
    canManage: isOrgAdminOrOwner,
    canManageMembers,
    canTransferOwnership,
    invitations,
    members,
    ...(denied ? SKIP_INJECTED_LOADS : {}),
  }
}) satisfies PageServerLoad

export const load: PageServerLoad = withInjectedLoad(
  ownLoad,
  '/(app)/projects/[projectId]/members',
  'page'
)

export const actions = injectActions('/(app)/projects/[projectId]/members')
