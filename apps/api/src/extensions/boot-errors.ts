import {
  ExtensionApiRouteBootError,
  type ExtensionApiRouteBootReason,
} from '../lib/secure-route-overrides.js'
import type { ExtensionLoadFailureReason, ExtensionState } from './loader.js'

/**
 * Story 68.8 AC-11 / Q15 — extension boot failures that stop `createApp()`, and the closed reason
 * set `startup.failed` reports for them in its sibling `extension` key (the DB `cause` key is
 * unchanged).
 */
export type ExtensionRequiredReason =
  'extension_required_load_failed' | 'extension_required_not_configured'

export type ExtensionBootFailure = {
  reason: ExtensionRequiredReason | ExtensionApiRouteBootReason
  loadFailureReason?: ExtensionLoadFailureReason
}

/** `VAULT_EXTENSIONS_REQUIRED=true` and the configured extension did not load (or none is set). */
export class ExtensionRequiredError extends Error {
  constructor(
    public readonly reason: ExtensionRequiredReason,
    message: string,
    public readonly loadFailureReason?: ExtensionLoadFailureReason
  ) {
    super(message)
    this.name = 'ExtensionRequiredError'
  }
}

/**
 * AC-11: with `VAULT_EXTENSIONS_REQUIRED` true, a missing package (Q4) or any load failure stops
 * the boot before any route registers. Unset or false keeps today's fail-open behaviour.
 */
export function assertExtensionRequirement(input: {
  required: boolean | undefined
  packageName: string | undefined
  state: ExtensionState
}): void {
  if (input.required !== true) return
  if (!input.packageName) {
    throw new ExtensionRequiredError(
      'extension_required_not_configured',
      'VAULT_EXTENSIONS_REQUIRED is true but VAULT_EXTENSIONS_PACKAGE is not set'
    )
  }
  if (input.state.status === 'load_failed') {
    throw new ExtensionRequiredError(
      'extension_required_load_failed',
      `VAULT_EXTENSIONS_REQUIRED is true and the extension failed to load (${input.state.reason})`,
      input.state.reason
    )
  }
}

const MAX_CAUSE_DEPTH = 10

/** The extension boot failure in an error's `cause` chain, if any. */
export function findExtensionBootFailure(err: unknown): ExtensionBootFailure | undefined {
  const seen = new Set<unknown>()
  let current: unknown = err
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth += 1) {
    if (seen.has(current)) return undefined
    seen.add(current)
    if (current instanceof ExtensionRequiredError) {
      return {
        reason: current.reason,
        ...(current.loadFailureReason ? { loadFailureReason: current.loadFailureReason } : {}),
      }
    }
    if (current instanceof ExtensionApiRouteBootError) return { reason: current.reason }
    current = current.cause
  }
  return undefined
}
