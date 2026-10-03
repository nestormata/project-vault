// Story 68.6 AC-3: PV's client hooks (`handleError`, `init`), composed with the UI pack's client
// hook contribution. PV defines neither, so in PV's own build both stay `undefined` and
// SvelteKit's default client error logging runs as before this file existed.
import { hooks as contributed } from 'virtual:pv-hooks/client'
import { composeClientHooks } from '$lib/composition/compose-client-hooks.js'

const composed = composeClientHooks({}, contributed)

export const handleError = composed.handleError
export const init = composed.init
