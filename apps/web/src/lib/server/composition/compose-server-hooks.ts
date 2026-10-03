// Story 68.6 AC-2/AC-4/AC-6 — the server hooks file (`src/hooks.server.ts`) composition: `handle`
// as `[...before, wrap ? wrap(pv) : pv, ...after]` with the composed header policy set once per
// request, and every other server hook per the AC-2 chain table.
import type {
  Handle,
  HandleFetch,
  HandleServerError,
  HandleValidationError,
  ServerInit,
} from '@sveltejs/kit'
import { composeChainHook, readHandleContribution } from '$lib/composition/hook-chain.js'
import {
  composeHeaderPolicy,
  type HeaderPolicy,
  type HeaderPolicyContribution,
} from '$lib/security/header-policy.js'
import { composeHandles, type ComposeHandlesOptions } from './compose-handles.js'

export interface PvServerHooks {
  handle: Handle
  handleFetch?: HandleFetch
  handleError?: HandleServerError
  handleValidationError?: HandleValidationError
  init?: ServerInit
}

export interface ComposedServerHooks extends PvServerHooks {
  /** The policy actually applied (PV's, or PV's with the contribution's `headerPolicy`). */
  headerPolicy: HeaderPolicy
}

export interface ComposeServerHooksOptions {
  headerPolicy: HeaderPolicy
  outsidePolicy?: ComposeHandlesOptions['outsidePolicy']
}

export function composeServerHooks(
  pv: PvServerHooks,
  contributed: Readonly<Record<string, unknown>>,
  options: ComposeServerHooksOptions
): ComposedServerHooks {
  const headerPolicy = composeHeaderPolicy(
    options.headerPolicy,
    contributed.headerPolicy as HeaderPolicyContribution | undefined
  )
  const { before, after, wrap } = readHandleContribution<Handle>(contributed.handle)
  const pvHandle = wrap ? wrap(pv.handle) : pv.handle
  if (typeof pvHandle !== 'function') {
    throw new TypeError(
      `hooks.server: wrap for "handle" must return a function (got ${typeof pvHandle})`
    )
  }
  return {
    headerPolicy,
    handle: composeHandles([...before, pvHandle, ...after], {
      headerPolicy,
      outsidePolicy: options.outsidePolicy,
    }),
    handleFetch: composeChainHook(
      'server',
      'handleFetch',
      pv.handleFetch,
      contributed.handleFetch
    ) as HandleFetch | undefined,
    handleError: composeChainHook(
      'server',
      'handleError',
      pv.handleError,
      contributed.handleError
    ) as HandleServerError | undefined,
    handleValidationError: composeChainHook(
      'server',
      'handleValidationError',
      pv.handleValidationError,
      contributed.handleValidationError
    ) as HandleValidationError | undefined,
    init: composeChainHook('server', 'init', pv.init, contributed.init) as ServerInit | undefined,
  }
}
