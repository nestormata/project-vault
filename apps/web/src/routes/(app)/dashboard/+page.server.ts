import { getProjectDashboard, listProjects } from '$lib/api/projects.js'
import type { PageServerLoad } from './$types.js'

export const load: PageServerLoad = async ({ fetch }) => {
  const projects = await listProjects(fetch)
  const selectedProject = projects.items[0] ?? null
  const dashboard = selectedProject ? await getProjectDashboard(fetch, selectedProject.id) : null

  return {
    projects,
    selectedProject,
    dashboard,
  }
}
