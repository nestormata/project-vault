import { requireUser } from '$lib/server/require-user.js'
import type { PageServerLoad } from './$types.js'

export const load: PageServerLoad = async ({ params, locals }) => {
  const orgRole = requireUser(locals).orgRole
  return {
    projectId: params.projectId,
    orgRole,
    canImport: orgRole === 'owner' || orgRole === 'admin',
  }
}
