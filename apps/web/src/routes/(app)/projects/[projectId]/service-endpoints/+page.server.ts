import { ApiClientError } from '$lib/api/client.js'
import { listAlerts } from '$lib/api/monitoring-alerts.js'
import { listServiceEndpointDetails } from '$lib/api/service-endpoints.js'
import { requireUser } from '$lib/server/require-user.js'
import type { PageServerLoad } from './$types.js'

export const load: PageServerLoad = async ({ params, fetch, locals }) => {
  const orgRole = requireUser(locals).orgRole

  try {
    // AC-F1: the API's `status` filter accepts a single value, so an "active or snoozed" view
    // requires either two calls or fetching unfiltered and filtering client-side. Two calls
    // chosen here — both endpoint and alert lists are unbounded-but-small (Background).
    const [endpoints, activeAlerts, snoozedAlerts] = await Promise.all([
      listServiceEndpointDetails(fetch, params.projectId),
      listAlerts(fetch, params.projectId, { status: 'active' }),
      listAlerts(fetch, params.projectId, { status: 'snoozed' }),
    ])
    return {
      projectId: params.projectId,
      orgRole,
      endpoints,
      alerts: [...activeAlerts.items, ...snoozedAlerts.items],
      notFound: false as const,
    }
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 404) {
      return {
        projectId: params.projectId,
        orgRole,
        endpoints: [],
        alerts: [],
        notFound: true as const,
      }
    }
    throw error
  }
}
