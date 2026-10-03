import { injectActions, withInjectedLoad } from '$lib/server/composition/inject-behavior.js'
import { listProjects } from '$lib/api/projects.js'
import type { PageServerLoad } from './$types.js'

const ownLoad = (async ({ fetch }) => {
  return { projects: await listProjects(fetch) }
}) satisfies PageServerLoad

export const load: PageServerLoad = withInjectedLoad(ownLoad, '/(app)/credentials', 'page')

export const actions = injectActions('/(app)/credentials')
