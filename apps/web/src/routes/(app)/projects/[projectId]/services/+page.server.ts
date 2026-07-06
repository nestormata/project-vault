import { ApiClientError } from '$lib/api/client.js'
import { listServices } from '$lib/api/services.js'
import { requireUser } from '$lib/server/require-user.js'
import type { PageServerLoad } from './$types.js'

export const load: PageServerLoad = async ({ params, fetch, locals }) => {
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
}
