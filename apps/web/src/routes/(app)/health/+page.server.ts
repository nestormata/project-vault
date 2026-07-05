import { getHealthDashboard } from '$lib/api/health-dashboard.js'
import type { PageServerLoad } from './$types.js'

export const load: PageServerLoad = async ({ fetch }) => {
  return { dashboard: await getHealthDashboard(fetch) }
}
