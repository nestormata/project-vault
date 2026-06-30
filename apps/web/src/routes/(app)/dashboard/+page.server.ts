import { ApiClientError } from '$lib/api/client.js'
import { getOrgDashboard } from '$lib/api/dashboard.js'
import { getProjectDashboard, listProjects } from '$lib/api/projects.js'
import type { PageServerLoad } from './$types.js'

export const load: PageServerLoad = async ({ fetch }) => {
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
}
