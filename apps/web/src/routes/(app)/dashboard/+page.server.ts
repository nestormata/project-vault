import { ApiClientError } from '$lib/api/client.js'
import { getProjectDashboard, listProjects } from '$lib/api/projects.js'
import type { PageServerLoad } from './$types.js'

export const load: PageServerLoad = async ({ fetch }) => {
  const projects = await listProjects(fetch)
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
  }
}
