// Story 68.6 AC-3: PV's universal hooks (`reroute`, `transport`), composed with the UI pack's
// universal hook contribution. PV defines neither, so in PV's own build both stay `undefined` and
// SvelteKit's defaults (noop reroute, `{}` transport) run as before this file existed.
import { hooks as contributed } from 'virtual:pv-hooks/universal'
import { composeUniversalHooks } from '$lib/composition/compose-universal-hooks.js'

const composed = composeUniversalHooks({}, contributed)

export const reroute = composed.reroute
export const transport = composed.transport
