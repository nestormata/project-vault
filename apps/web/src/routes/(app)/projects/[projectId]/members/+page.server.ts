import { listInvitations } from '$lib/api/invitations.js'
import { requireUser } from '$lib/server/require-user.js'
import type { PageServerLoad } from './$types.js'

export const load: PageServerLoad = async ({ params, fetch, locals }) => {
  const orgRole = requireUser(locals).orgRole
  const canManage = orgRole === 'owner' || orgRole === 'admin'

  let invitations: Awaited<ReturnType<typeof listInvitations>> = []
  if (canManage) {
    try {
      invitations = await listInvitations(fetch, params.projectId)
    } catch {
      invitations = []
    }
  }

  return { projectId: params.projectId, canManage, invitations }
}
