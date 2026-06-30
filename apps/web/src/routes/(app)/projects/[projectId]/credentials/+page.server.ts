import { listCredentials } from '$lib/api/credentials.js'
import { ApiClientError } from '$lib/api/client.js'
import {
  credentialListFilterView,
  parseCredentialListFilters,
} from '$lib/credentials/list-filters.js'
import { requireUser } from '$lib/server/require-user.js'
import type { PageServerLoad } from './$types.js'

export const load: PageServerLoad = async ({ params, fetch, url, locals }) => {
  const filters = parseCredentialListFilters(url)
  const orgRole = requireUser(locals).orgRole
  const filterView = credentialListFilterView(filters)

  try {
    const credentials = await listCredentials(fetch, params.projectId, filters)
    return { projectId: params.projectId, orgRole, credentials, filters: filterView }
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 404) {
      return {
        projectId: params.projectId,
        orgRole,
        credentials: { items: [], total: 0, page: 1, limit: 20, hasNext: false },
        filters: filterView,
        notFound: true as const,
      }
    }
    throw error
  }
}
