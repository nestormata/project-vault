import { ApiClientError } from '$lib/api/client.js'
import { getOrgDashboard } from '$lib/api/dashboard.js'
import { getProjectDashboard, listProjects } from '$lib/api/projects.js'
import type { PageServerLoad } from './$types.js'

export const load: PageServerLoad = async ({ fetch }) => {
  // AC-4: listProjects/getOrgDashboard/getProjectDashboard are all vault-guarded, but their
  // existing error-handling is inconsistent (listProjects has zero catch of any kind today;
  // getOrgDashboard's .catch() and getProjectDashboard's try/catch both only special-case 404,
  // never 503) — rather than bolting a differently-shaped 503 branch onto each, this one outer
  // try/catch wraps the entire loader body so a 503 from any of the three (however it surfaces)
  // is caught here. A sealed vault means none of the dashboard's data is reliable, so the sealed
  // response discards anything already fetched rather than rendering a partially-degraded
  // dashboard (D1's "any one call failing sealed means none of them are reliable" reasoning).
  try {
    const [projects, orgDashboard] = await Promise.all([
      listProjects(fetch),
      getOrgDashboard(fetch).catch((error) => {
        if (error instanceof ApiClientError && error.status === 404) return null
        throw error
      }),
    ])

    const selectedProject = projects.items[0] ?? null
    let dashboard = null
    if (selectedProject) {
      try {
        dashboard = await getProjectDashboard(fetch, selectedProject.id)
      } catch (error) {
        if (!(error instanceof ApiClientError && error.status === 404)) throw error
      }
    }

    return {
      projects,
      selectedProject: dashboard ? selectedProject : null,
      dashboard,
      orgDashboard,
    }
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 503) {
      return {
        projects: { items: [] },
        selectedProject: null,
        dashboard: null,
        orgDashboard: null,
        vaultSealed: true as const,
      }
    }
    throw error
  }
}
