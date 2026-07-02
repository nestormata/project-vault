import { listInvitations } from '$lib/api/invitations.js'
import { listProjectMembers, type ProjectMember } from '$lib/api/org-users.js'
import { requireUser } from '$lib/server/require-user.js'
import type { PageServerLoad } from './$types.js'

export const load: PageServerLoad = async ({ params, fetch, locals }) => {
  const user = requireUser(locals)
  const orgRole = user.orgRole
  const isOrgAdminOrOwner = orgRole === 'owner' || orgRole === 'admin'

  let invitations: Awaited<ReturnType<typeof listInvitations>> = []
  let members: ProjectMember[] = []
  if (isOrgAdminOrOwner) {
    try {
      invitations = await listInvitations(fetch, params.projectId)
    } catch {
      invitations = []
    }
  }

  // The member list is authorized on the project-role axis (AC-10): a project admin/owner who
  // is only an org member can still view/manage it, so we always attempt it and degrade to [].
  try {
    members = await listProjectMembers(fetch, params.projectId)
  } catch {
    members = []
  }

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
  }
}
