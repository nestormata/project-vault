import { injectActions, withInjectedLoad } from '$lib/server/composition/inject-behavior.js'
import { ApiClientError } from '$lib/api/client.js'
import { listServices } from '$lib/api/services.js'
import { requireUser } from '$lib/server/require-user.js'
import type { PageServerLoad } from './$types.js'

const ownLoad = (async ({ params, fetch, locals }) => {
  const orgRole = requireUser(locals).orgRole

  try {
    const services = await listServices(fetch, params.projectId)
    return { projectId: params.projectId, orgRole, services, notFound: false as const }
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 404) {
      return { projectId: params.projectId, orgRole, services: [], notFound: true as const }
    }
    throw error
  }
}) satisfies PageServerLoad

export const load: PageServerLoad = withInjectedLoad(
  ownLoad,
  '/(app)/projects/[projectId]/services',
  'page'
)

export const actions = injectActions('/(app)/projects/[projectId]/services')
