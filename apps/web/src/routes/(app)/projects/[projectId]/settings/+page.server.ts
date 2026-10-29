import { injectActions, withInjectedLoad } from '$lib/server/composition/inject-behavior.js'
import { ApiClientError } from '$lib/api/client.js'
import { getProject } from '$lib/api/projects.js'
import { requireUser } from '$lib/server/require-user.js'
import type { PageServerLoad } from './$types.js'

// Story 72-9: the project settings page's loader (edit and delete). Only a 404 is special-cased to
// the honest not-found result, like the overview page; the API enforces who may edit or delete.
const ownLoad = (async ({ params, fetch, locals }) => {
  const orgRole = requireUser(locals).orgRole
  try {
    const project = await getProject(fetch, params.projectId)
    return { projectId: params.projectId, orgRole, project, notFound: false as const }
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 404) {
      return { projectId: params.projectId, orgRole, project: null, notFound: true as const }
    }
    throw error
  }
}) satisfies PageServerLoad

export const load: PageServerLoad = withInjectedLoad(
  ownLoad,
  '/(app)/projects/[projectId]/settings',
  'page'
)

export const actions = injectActions('/(app)/projects/[projectId]/settings')
