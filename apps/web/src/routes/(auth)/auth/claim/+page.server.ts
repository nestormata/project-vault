import { injectActions, withInjectedLoad } from '$lib/server/composition/inject-behavior.js'
import { env } from '$env/dynamic/private'
import { resolveCentralizeMeOrigin } from '$lib/server/handoff-return-origin.js'
import type { PageServerLoad } from './$types'

// Story 73.1: the claim itself runs in the browser (the token is in the URL fragment, which never
// reaches a server). The load only resolves the return-guidance origin, per request, from the web
// process's own VAULT_HANDOFF_ISSUER, never from the URL.
const ownLoad = (() => ({
  centralizeMeOrigin: resolveCentralizeMeOrigin(env.VAULT_HANDOFF_ISSUER),
})) satisfies PageServerLoad

export const load: PageServerLoad = withInjectedLoad(ownLoad, '/(auth)/auth/claim', 'page')

export const actions = injectActions('/(auth)/auth/claim')
