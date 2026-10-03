import { injectActions, withInjectedLoad } from '$lib/server/composition/inject-behavior.js'
import { listProjects } from '$lib/api/projects.js'
import { requireUser } from '$lib/server/require-user.js'
import type { PageServerLoad } from './$types.js'

const ownLoad = (async ({ fetch, locals }) => {
  const orgRole = requireUser(locals).orgRole
  const canImport = orgRole === 'owner' || orgRole === 'admin'
  return {
    projects: await listProjects(fetch),
    canImport,
    orgRole,
  }
}) satisfies PageServerLoad

export const load: PageServerLoad = withInjectedLoad(ownLoad, '/(app)/credentials/import', 'page')

export const actions = injectActions('/(app)/credentials/import')
