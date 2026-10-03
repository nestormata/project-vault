import { injectActions, withInjectedLoad } from '$lib/server/composition/inject-behavior.js'
import { ApiClientError } from '$lib/api/client.js'
import { getServiceEndpoint } from '$lib/api/service-endpoints.js'
import { requireUser } from '$lib/server/require-user.js'
import type { PageServerLoad } from './$types.js'

const ownLoad = (async ({ params, fetch, locals }) => {
  const orgRole = requireUser(locals).orgRole

  try {
    const endpoint = await getServiceEndpoint(fetch, params.projectId, params.serviceEndpointId)
    return { projectId: params.projectId, orgRole, endpoint, notFound: false as const }
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 404) {
      return { projectId: params.projectId, orgRole, endpoint: null, notFound: true as const }
    }
    throw error
  }
}) satisfies PageServerLoad

export const load: PageServerLoad = withInjectedLoad(
  ownLoad,
  '/(app)/projects/[projectId]/service-endpoints/[serviceEndpointId]',
  'page'
)

export const actions = injectActions(
  '/(app)/projects/[projectId]/service-endpoints/[serviceEndpointId]'
)
