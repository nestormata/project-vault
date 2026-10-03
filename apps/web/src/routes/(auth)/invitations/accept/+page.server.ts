import { injectActions, injectLoad } from '$lib/server/composition/inject-behavior.js'
import type { PageServerLoad } from './$types.js'

export const load: PageServerLoad = (event) =>
  injectLoad(event, '/(auth)/invitations/accept', 'page')
export const actions = injectActions('/(auth)/invitations/accept')
