import { requireUser } from '$lib/server/require-user.js'
import type { PageServerLoad } from './$types.js'

export const load: PageServerLoad = async ({ params, locals }) => {
  return {
    projectId: params.projectId,
    orgRole: requireUser(locals).orgRole,
  }
}
