// Story 68.6 AC-2/AC-3 — the client hooks file (`src/hooks.client.ts`): `handleError` and `init`.
import type { ClientInit, HandleClientError } from '@sveltejs/kit'
import { composeChainHook } from './hook-chain.js'

export interface ClientHooks {
  handleError?: HandleClientError
  init?: ClientInit
}

export function composeClientHooks(
  pv: ClientHooks,
  contributed: Readonly<Record<string, unknown>>
): ClientHooks {
  return {
    handleError: composeChainHook(
      'client',
      'handleError',
      pv.handleError,
      contributed.handleError
    ) as HandleClientError | undefined,
    init: composeChainHook('client', 'init', pv.init, contributed.init) as ClientInit | undefined,
  }
}
