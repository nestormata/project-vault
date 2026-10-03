import { injectActions, withInjectedLoad } from '$lib/server/composition/inject-behavior.js'
import { ApiClientError } from '$lib/api/client.js'
import { getService } from '$lib/api/services.js'
import { requireUser } from '$lib/server/require-user.js'
import type { PageServerLoad } from './$types.js'

const ownLoad = (async ({ params, fetch, locals }) => {
  const orgRole = requireUser(locals).orgRole

  try {
    const service = await getService(fetch, params.projectId, params.serviceId)
    return { projectId: params.projectId, orgRole, service, notFound: false as const }
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 404) {
      return { projectId: params.projectId, orgRole, service: null, notFound: true as const }
    }
    throw error
  }
}) satisfies PageServerLoad

export const load: PageServerLoad = withInjectedLoad(
  ownLoad,
  '/(app)/projects/[projectId]/services/[serviceId]',
  'page'
)

export const actions = injectActions('/(app)/projects/[projectId]/services/[serviceId]')
