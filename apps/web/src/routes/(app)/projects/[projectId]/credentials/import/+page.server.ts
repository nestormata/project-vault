import { injectActions, withInjectedLoad } from '$lib/server/composition/inject-behavior.js'
import { requireUser } from '$lib/server/require-user.js'
import type { PageServerLoad } from './$types.js'

const ownLoad = (({ params, locals }) => {
  const orgRole = requireUser(locals).orgRole
  return {
    projectId: params.projectId,
    orgRole,
    canImport: orgRole === 'owner' || orgRole === 'admin',
  }
}) satisfies PageServerLoad

export const load: PageServerLoad = withInjectedLoad(
  ownLoad,
  '/(app)/projects/[projectId]/credentials/import',
  'page'
)

export const actions = injectActions('/(app)/projects/[projectId]/credentials/import')
