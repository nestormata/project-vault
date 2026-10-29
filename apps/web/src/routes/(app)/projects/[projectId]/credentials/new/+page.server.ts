import { injectActions, withInjectedLoad } from '$lib/server/composition/inject-behavior.js'
import { projectFormPageLoad } from '$lib/server/project-form-page.js'
import type { PageServerLoad } from './$types.js'

const ownLoad = ((event) => {
  // Story 72.8 (P11): this form takes a secret value, so the page is never stored.
  event.setHeaders({ 'cache-control': 'no-store' })
  return projectFormPageLoad(event)
}) satisfies PageServerLoad

export const load: PageServerLoad = withInjectedLoad(
  ownLoad,
  '/(app)/projects/[projectId]/credentials/new',
  'page'
)

export const actions = injectActions('/(app)/projects/[projectId]/credentials/new')
