/**
 * Story 58.2 — shared extraction of the identical in-flight-cap-plus-audit-logging-on-every-outcome
 * wrapper shape independently hand-implemented by `monitoring-host.ts`'s `callOutOfRequestMethod`
 * (Story 34.1) and `notification-originator-host.ts`'s `callOutOfRequestEnqueue` (Story 58.1). See
 * `epic-58-retro-2026-09-19.md` Finding 2 for the motivating duplication finding.
 *
 * This module is deliberately domain-agnostic: it has no knowledge of `OperationalEvent` constants,
 * audit field shapes, or any specific `RateLimitedError` subclass. Every host-specific behavior is
 * supplied by the caller as a hook (see Design Decision 1 in the story file).
 */

/**
 * Story 58.2 Design Decision 2 — a per-namespace in-flight slot accounting instance. Each host owns
 * a single, distinct instance created once at module scope (never a shared `Map`, never shared keys
 * within one `Map`) so that two hosts' budgets can never collide, even for the same extension name.
 */
export type InFlightSlotAccounting = {
  /** Attempts to acquire a slot for `extensionName`, bounded by `max`. Returns `true` and
   * increments the count on success; returns `false` (no state change) when already at `max`.
   * `max: 0` denies unconditionally (falls out of `count < max` naturally — no special-casing). */
  tryAcquire(extensionName: string, max: number): boolean
  /** Releases a previously-acquired slot for `extensionName`. Clamped at zero: a double-release
   * (two calls with no matching second `tryAcquire`) never goes negative — mirrors both hosts'
   * pre-existing `releaseSlot`-equivalent guard, extracted verbatim. */
  release(extensionName: string): void
  /** Test-only introspection of the current in-flight count for `extensionName`. */
  getCount(extensionName: string): number
  /** Test-only reset of all accounting state for this instance. */
  reset(): void
}

/** Module-scope registry of every `namespace` string `createInFlightSlotAccounting` has been
 * called with, in this process. Story 58.2 Design Decision 2 (added via Pre-mortem Analysis
 * elicitation) — guards against a future caller accidentally wiring two hosts to the same
 * namespace, which would silently merge two previously-independent in-flight budgets. */
const usedNamespaces = new Set<string>()

/**
 * Creates a fresh, `Map`-backed in-flight slot accounting instance scoped to `namespace`. Throws
 * synchronously if `namespace` has already been used by an earlier call to this factory in the same
 * process — a structural guard against two hosts (or a future third host) silently sharing one
 * accounting budget.
 */
export function createInFlightSlotAccounting(namespace: string): InFlightSlotAccounting {
  if (usedNamespaces.has(namespace)) {
    throw new Error(
      `createInFlightSlotAccounting: namespace "${namespace}" is already in use — each caller must use a distinct namespace so in-flight budgets can never collide`
    )
  }
  usedNamespaces.add(namespace)

  const counts = new Map<string, number>()

  function keyFor(extensionName: string): string {
    return `${namespace}:${extensionName}`
  }

  return {
    tryAcquire(extensionName, max) {
      const key = keyFor(extensionName)
      const current = counts.get(key) ?? 0
      if (current >= max) return false
      counts.set(key, current + 1)
      return true
    },
    release(extensionName) {
      const key = keyFor(extensionName)
      const current = counts.get(key) ?? 0
      if (current <= 1) counts.delete(key)
      else counts.set(key, current - 1)
    },
    getCount(extensionName) {
      return counts.get(keyFor(extensionName)) ?? 0
    },
    reset() {
      counts.clear()
    },
  }
}

export type CallOutOfRequestHostMethodParams<T> = {
  accounting: InFlightSlotAccounting
  extensionName: string
  maxInFlight: number
  /** Called when the in-flight cap denies the call, BEFORE `fn()` is ever invoked. Must throw —
   * the `never` return type lets the compiler prove there is no fallthrough into `fn()`. If a
   * caller-supplied `onDenied` violates its own contract and returns instead of throwing, that is
   * undefined behavior (not a defended-against runtime case — TypeScript's `never` type is the
   * primary guard here). */
  onDenied: () => never
  /** Called exactly once per call, with the final classified outcome and (for non-`'ok'` outcomes)
   * the thrown error. */
  onOutcome: (outcome: string, error?: unknown) => void
  /** Classifies a caught error into an outcome string for `onOutcome`. Defaults to
   * `() => 'error'` (monitoring's existing, unclassified behavior). If `classifyOutcome` itself
   * throws, that exception propagates out of this wrapper's own `catch` block — it is NOT swallowed
   * or coerced to `outcome: 'error'`. This is a deliberate contract choice, not an oversight. */
  classifyOutcome?: (error: unknown) => string
  fn: () => Promise<T>
}

/**
 * Story 58.2 Design Decision 1 — the shared control-flow wrapper both `monitoring-host.ts` and
 * `notification-originator-host.ts` call internally: acquire an in-flight slot → deny path (via
 * `onDenied`, never returns) → run `fn()` → `onOutcome('ok')` → catch → `onOutcome(classifyOutcome(
 * error), error)` → rethrow → `finally` release. Host-specific audit-field shape, warn-log wording,
 * and error classification all live in the caller-supplied hooks — this function has no knowledge
 * of any of them.
 */
export async function callOutOfRequestHostMethod<T>(
  params: CallOutOfRequestHostMethodParams<T>
): Promise<T> {
  const { accounting, extensionName, maxInFlight, onDenied, onOutcome, fn } = params
  const classifyOutcome = params.classifyOutcome ?? (() => 'error')

  if (!accounting.tryAcquire(extensionName, maxInFlight)) {
    onDenied()
  }

  try {
    const result = await fn()
    onOutcome('ok')
    return result
  } catch (error) {
    onOutcome(classifyOutcome(error), error)
    throw error
  } finally {
    accounting.release(extensionName)
  }
}
