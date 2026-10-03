import { injectActions, withInjectedLoad } from '$lib/server/composition/inject-behavior.js'
import { listProjects } from '$lib/api/projects.js'
import type { PageServerLoad } from './$types.js'

const ownLoad = (async ({ fetch, url }) => {
  const includeArchived = url.searchParams.get('includeArchived') === 'true'
  return {
    projects: await listProjects(fetch, { includeArchived }),
    includeArchived,
  }
}) satisfies PageServerLoad

export const load: PageServerLoad = withInjectedLoad(ownLoad, '/(app)/projects', 'page')

export const actions = injectActions('/(app)/projects')
