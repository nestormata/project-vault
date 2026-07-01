import { listOrgUsers, type OrgUser } from '$lib/api/org-users.js'
import { requireUser } from '$lib/server/require-user.js'
import type { PageServerLoad } from './$types.js'

export const load: PageServerLoad = async ({ fetch, locals }) => {
  const orgRole = requireUser(locals).orgRole
  const canManage = orgRole === 'owner' || orgRole === 'admin'

  let users: OrgUser[] = []
  if (canManage) {
    try {
      users = await listOrgUsers(fetch)
    } catch {
      users = []
    }
  }

  return { canManage, orgRole, users }
}
