import { injectActions, injectLoad } from '$lib/server/composition/inject-behavior.js'
import type { PageServerLoad } from './$types.js'

export const load: PageServerLoad = (event) => injectLoad(event, '/(auth)/recovery', 'page')
export const actions = injectActions('/(auth)/recovery')
