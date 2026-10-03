// Story 68.6 AC-2/AC-3 — the universal hooks file (`src/hooks.ts`): `reroute` and `transport`.
import type { Reroute, Transport } from '@sveltejs/kit'
import { composeChainHook } from './hook-chain.js'

export interface UniversalHooks {
  reroute?: Reroute
  transport?: Transport
}

export function composeUniversalHooks(
  pv: UniversalHooks,
  contributed: Readonly<Record<string, unknown>>
): UniversalHooks {
  return {
    reroute: composeChainHook('universal', 'reroute', pv.reroute, contributed.reroute) as
      Reroute | undefined,
    transport: composeChainHook('universal', 'transport', pv.transport, contributed.transport) as
      Transport | undefined,
  }
}
