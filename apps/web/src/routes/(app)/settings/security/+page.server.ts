import { injectActions, withInjectedLoad } from '$lib/server/composition/inject-behavior.js'
import { requireUser } from '$lib/server/require-user.js'
import type { PageServerLoad } from './$types.js'

const ownLoad = (({ locals }) => {
  return { user: requireUser(locals) }
}) satisfies PageServerLoad

export const load: PageServerLoad = withInjectedLoad(ownLoad, '/(app)/settings/security', 'page')

export const actions = injectActions('/(app)/settings/security')
