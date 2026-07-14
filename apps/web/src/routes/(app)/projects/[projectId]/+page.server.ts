import { ApiClientError } from '$lib/api/client.js'
import { getProject, getProjectDashboard } from '$lib/api/projects.js'
import { requireUser } from '$lib/server/require-user.js'
import type { PageServerLoad } from './$types.js'

// 12-1 AC-1/AC-2/AC-3/AC-5: the project overview page's loader. Mirrors the credentials sub-route
// loader's shape (only 404 is special-cased to an honest not-found result; every other error,
// including the 422 a malformed project ID produces, propagates unmodified — AC-4 requires reusing
// that exact established pattern rather than inventing new validation here).
export const load: PageServerLoad = async ({ params, fetch, locals }) => {
  const orgRole = requireUser(locals).orgRole

  try {
    const project = await getProject(fetch, params.projectId)
    // AC-3: the visibility/404 check above must complete before any summary data is fetched, so
    // a 404 never leaks so much as a network call for the dashboard aggregate.
    const dashboard = await getProjectDashboard(fetch, params.projectId)
    return { projectId: params.projectId, orgRole, project, dashboard, notFound: false as const }
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 404) {
      return {
        projectId: params.projectId,
        orgRole,
        project: null,
        dashboard: null,
        notFound: true as const,
      }
    }
    throw error
  }
}
