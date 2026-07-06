import { getHealthDashboard } from '$lib/api/health-dashboard.js'
import { listProjects } from '$lib/api/projects.js'
import type { PageServerLoad } from './$types.js'

export const load: PageServerLoad = async ({ fetch }) => {
  const [dashboard, projects] = await Promise.all([getHealthDashboard(fetch), listProjects(fetch)])

  // AC-A2: when the empty state's "register a service endpoint" link has exactly one project to
  // go to, skip the unnecessary intermediate list-of-one and link straight to it.
  const singleProjectId = projects.items.length === 1 ? (projects.items[0]?.id ?? null) : null

  return { dashboard, singleProjectId }
}
