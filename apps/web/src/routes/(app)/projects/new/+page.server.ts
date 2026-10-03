import { injectActions, injectLoad } from '$lib/server/composition/inject-behavior.js'
import type { PageServerLoad } from './$types.js'

export const load: PageServerLoad = (event) => injectLoad(event, '/(app)/projects/new', 'page')
export const actions = injectActions('/(app)/projects/new')
