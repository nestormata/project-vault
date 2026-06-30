import { listProjects } from '$lib/api/projects.js'
import { requireUser } from '$lib/server/require-user.js'
import type { PageServerLoad } from './$types.js'

export const load: PageServerLoad = async ({ fetch, locals }) => {
  const orgRole = requireUser(locals).orgRole
  const canImport = orgRole === 'owner' || orgRole === 'admin'
  return {
    projects: await listProjects(fetch),
    canImport,
    orgRole,
  }
}
