import { injectActions, withInjectedLoad } from '$lib/server/composition/inject-behavior.js'
import { ApiClientError } from '$lib/api/client.js'
import { listDeletedProjects } from '$lib/api/projects.js'
import type { PageServerLoad } from './$types.js'

// Story 72-9: the projects awaiting purge that the caller may restore. The API only lists those,
// so a 403 (an org viewer) is an empty list, not an error page.
const ownLoad = (async ({ fetch }) => {
  try {
    return { deleted: await listDeletedProjects(fetch) }
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 403) return { deleted: [] }
    throw error
  }
}) satisfies PageServerLoad

export const load: PageServerLoad = withInjectedLoad(ownLoad, '/(app)/projects/deleted', 'page')

export const actions = injectActions('/(app)/projects/deleted')
