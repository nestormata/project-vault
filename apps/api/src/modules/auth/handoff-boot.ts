import type { FastifyBaseLogger } from 'fastify'
import { OperationalEvent } from '@project-vault/shared'
import { env, handoffVerifyKeys } from '../../config/env.js'
import { operationalLog } from '../../lib/logger.js'
import { registerAuthStrategy } from './strategies.js'
import { isNativeLoginEnabled } from './native-login-policy.js'

/**
 * Story 30.2 AC2: the boot-time handoff `AuthStrategy` registration gate. Called once from
 * `createApp()`, strictly AFTER `resolveNativeLoginPolicy()` has resolved (this function calls
 * `isNativeLoginEnabled()`, which throws if the policy hasn't resolved yet).
 *
 * `centralizeme-handoff` is registered as a pure marker in `strategies.ts`'s append-only
 * registry — no route in this repo ever calls `findAuthStrategy('centralizeme-handoff')`
 * (AC2.6): `/auth/handoff/prepare`/`/auth/handoff/confirm` (handoff-routes.ts) implement the full
 * verify/burn/session flow directly and never dispatch through the generic SSO
 * start/callback machinery. The registered strategy's `onAuthenticate()` is therefore dead code
 * by construction — it exists only to satisfy the `AuthStrategy` type shape the registry
 * requires, and it always rejects if anything ever calls it, so a future regression that
 * accidentally wires a generic dispatch path to this provider name fails loudly instead of
 * silently doing the wrong thing.
 */
export async function resolveHandoffAuthStrategy(
  logger: Partial<Pick<FastifyBaseLogger, 'info' | 'warn' | 'error' | 'fatal'>>
): Promise<void> {
  // AC2.5: "an operator has otherwise signaled intent to enable handoff auth" — the explicit
  // VAULT_HANDOFF_ENABLED toggle this story defines. Unset (default false): silently no-op,
  // even if VAULT_HANDOFF_INSTANCE_ID/VAULT_HANDOFF_VERIFY_KEYS happen to be configured (Story
  // 30.1 AC2.6/AC2.7 — their presence alone never implies enablement).
  if (!env['VAULT_HANDOFF_ENABLED']) return

  const instanceId = env['VAULT_HANDOFF_INSTANCE_ID'] as string | undefined
  const hasInstanceId = typeof instanceId === 'string' && instanceId.length > 0
  const hasKeys = handoffVerifyKeys.length > 0

  if (hasInstanceId && hasKeys) {
    registerAuthStrategy('centralizeme-handoff', {
      onAuthenticate: () =>
        Promise.reject(
          new Error(
            'centralizeme-handoff AuthStrategy.onAuthenticate must never be invoked — ' +
              'Story 30.2 dispatches through dedicated /auth/handoff/prepare and ' +
              '/auth/handoff/confirm routes, never through findAuthStrategy() generic dispatch.'
          )
        ),
    })
    operationalLog(
      logger,
      'info',
      OperationalEvent.HANDOFF_STRATEGY_REGISTERED,
      'centralizeme-handoff AuthStrategy registered'
    )
    return
  }

  // AC2.5 edge case: either config value is missing/empty while enablement was explicitly
  // signaled — the exact two-branch pattern native-login-policy.ts already established.
  if (isNativeLoginEnabled()) {
    operationalLog(
      logger,
      'fatal',
      OperationalEvent.HANDOFF_BOOT_MISCONFIGURED_FAIL_SAFE,
      'VAULT_HANDOFF_ENABLED is set but VAULT_HANDOFF_INSTANCE_ID or VAULT_HANDOFF_VERIFY_KEYS ' +
        'is missing/empty — handoff auth NOT registered; native login remains enabled ' +
        '(fail-safe)',
      { hasInstanceId, hasKeys }
    )
    return
  }

  // Native login is excluded on this instance — "a log line with no usable login path is not
  // acceptable" (claim contract, Key provisioning section). Refuse to boot into this
  // configuration at all.
  throw new Error(
    'VAULT_HANDOFF_ENABLED is set but VAULT_HANDOFF_INSTANCE_ID or VAULT_HANDOFF_VERIFY_KEYS ' +
      'is missing/empty, and native login is excluded on this instance — refusing to boot into ' +
      'a configuration with no usable login path.'
  )
}
