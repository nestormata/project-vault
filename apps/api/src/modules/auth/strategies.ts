import type { AuthStrategy } from '@project-vault/extension-api'
import type { ExtensionState } from '../../extensions/loader.js'

/**
 * Story 14.3 AC-1/AC-2: the registered-auth-strategy list. `authStrategies[0]` is a stable,
 * always-present local-strategy marker seeded at module load — no extension can override,
 * remove, or reorder it. Append-only: `registerAuthStrategy()` is the only mutation API, and it
 * never inserts anywhere but the end of the array. There is no remove/replace API surface at all.
 */
export type AuthStrategyEntry = { providerName: string; strategy: AuthStrategy | null }

const LOCAL_STRATEGY_MARKER: AuthStrategyEntry = { providerName: 'local', strategy: null }

function seed(): AuthStrategyEntry[] {
  return [LOCAL_STRATEGY_MARKER]
}

export const authStrategies: AuthStrategyEntry[] = seed()

/**
 * AC-2: appends `{ providerName, strategy }` at the end of `authStrategies` (never index 0).
 * Throws synchronously — without mutating the array — for the reserved `'local'` name (AC-1 edge
 * case) or a second registration for a provider name already present (AC-2 edge case:
 * idempotency guard, mirroring Story 14.2's loader double-invocation guard).
 */
export function registerAuthStrategy(providerName: string, strategy: AuthStrategy): void {
  if (providerName === 'local') {
    throw new Error("registerAuthStrategy: 'local' is a reserved provider name")
  }
  if (authStrategies.some((entry) => entry.providerName === providerName)) {
    throw new Error(`registerAuthStrategy: provider "${providerName}" is already registered`)
  }
  authStrategies.push({ providerName, strategy })
}

/**
 * Resolves a registered NON-local strategy by provider name. Always returns undefined for
 * 'local' — local auth never goes through this dispatch path (AC-3/AC-11 edge cases) — and for
 * any provider name with no registered entry.
 */
export function findAuthStrategy(
  providerName: string
): { providerName: string; strategy: AuthStrategy } | undefined {
  if (providerName === 'local') return undefined
  const entry = authStrategies.find((candidate) => candidate.providerName === providerName)
  if (!entry || !entry.strategy) return undefined
  return { providerName: entry.providerName, strategy: entry.strategy }
}

/**
 * Story 14.3 Task 3: the `createApp()` wiring step, called once after `loadExtension()` resolves.
 * Reads `getExtensionStatus()`'s already-resolved state (never the loader's internals — Story
 * 14.2's stated "small, focused accessors" design intent) and, if the extension loaded with an
 * `authStrategy` hook declared, registers it. No-ops (never throws) for every other state —
 * `not_configured`, `load_failed`, or `loaded` with no `authStrategy` hook — so
 * `authStrategies` correctly stays local-only (length 1) in all of those cases (AC-2 edge cases).
 * Guards against double-invocation the same way `registerAuthStrategy()` itself already does
 * (throwing on a duplicate name) — swallowed here since a second `createApp()`-driven call in the
 * same process is a caller bug, not a request-time error worth surfacing.
 */
export function wireExtensionAuthStrategy(state: ExtensionState): void {
  if (state.status !== 'loaded') return
  const authStrategy = state.hooks.authStrategy
  if (!authStrategy) return
  try {
    registerAuthStrategy(state.manifest.name, authStrategy)
  } catch {
    // Already registered (double-invocation) — no-op, matching Story 14.2's loader precedent.
  }
}

/** Test-only reset of module-level state — never called from production code. */
export function __resetAuthStrategiesForTests(): void {
  authStrategies.length = 0
  authStrategies.push(...seed())
}
