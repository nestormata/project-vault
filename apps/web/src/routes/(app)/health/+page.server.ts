import { getHealthDashboard } from '$lib/api/health-dashboard.js'
import { listProjects } from '$lib/api/projects.js'
import type { PageServerLoad } from './$types.js'

export const load: PageServerLoad = async ({ fetch }) => {
  // Code-review finding: listProjects only supports the cosmetic "link straight to the sole
  // project" empty-state shortcut (AC-A2) — it must never be able to take down the whole,
  // otherwise-independent health dashboard if it fails. Fetch both in parallel but isolate
  // listProjects's outcome with allSettled so a transient failure there degrades gracefully
  // (singleProjectId falls back to null, same as the "zero/multiple projects" case) instead of
  // throwing and failing the entire page load.
  const [dashboardResult, projectsResult] = await Promise.allSettled([
    getHealthDashboard(fetch),
    listProjects(fetch),
  ])

  if (dashboardResult.status === 'rejected') throw dashboardResult.reason

  const singleProjectId =
    projectsResult.status === 'fulfilled' && projectsResult.value.items.length === 1
      ? (projectsResult.value.items[0]?.id ?? null)
      : null

  return { dashboard: dashboardResult.value, singleProjectId }
}
