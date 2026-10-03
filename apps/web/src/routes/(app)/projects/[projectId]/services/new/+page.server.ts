import { injectActions, withInjectedLoad } from '$lib/server/composition/inject-behavior.js'
import { projectFormPageLoad } from '$lib/server/project-form-page.js'
import type { PageServerLoad } from './$types.js'

export const load: PageServerLoad = withInjectedLoad(
  projectFormPageLoad,
  '/(app)/projects/[projectId]/services/new',
  'page'
)

export const actions = injectActions('/(app)/projects/[projectId]/services/new')
