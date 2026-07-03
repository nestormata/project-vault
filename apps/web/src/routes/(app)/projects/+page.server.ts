import { listProjects } from '$lib/api/projects.js'
import type { PageServerLoad } from './$types.js'

export const load: PageServerLoad = async ({ fetch, url }) => {
  const includeArchived = url.searchParams.get('includeArchived') === 'true'
  return {
    projects: await listProjects(fetch, { includeArchived }),
    includeArchived,
  }
}
