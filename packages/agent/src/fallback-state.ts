export type FallbackState = {
  inFallback: boolean
  consecutiveFailures: number
  windowStartedAt: number | null
  lastLiveRetryAt: number
}

const FAILURE_WINDOW_MS = 30_000
const LIVE_RETRY_INTERVAL_MS = 30_000

export function createFallbackState(): FallbackState {
  return { inFallback: false, consecutiveFailures: 0, windowStartedAt: null, lastLiveRetryAt: 0 }
}

/**
 * AC-11 — a network-level failure (connection refused, timeout, DNS failure — never a resolved
 * 4xx/5xx HTTP response, which is a server answer, not an unreachable-vault condition). Requires
 * `threshold` *consecutive* failures within a rolling 30-second window; any success resets the
 * counter to 0 (`recordSuccess`), so 2 failures followed by a success never trips fallback mode.
 * Mutates and returns `state` for convenient chaining in the caller's retry loop.
 */
export function recordNetworkFailure(
  state: FallbackState,
  threshold: number,
  now: number = Date.now()
): FallbackState {
  if (state.windowStartedAt === null || now - state.windowStartedAt > FAILURE_WINDOW_MS) {
    state.windowStartedAt = now
    state.consecutiveFailures = 0
  }
  state.consecutiveFailures += 1
  if (state.consecutiveFailures >= threshold) state.inFallback = true
  return state
}

/** Any successful live call (even a non-2xx HTTP response) resets the counter and exits fallback. */
export function recordSuccess(state: FallbackState): FallbackState {
  state.consecutiveFailures = 0
  state.windowStartedAt = null
  state.inFallback = false
  return state
}

/**
 * AC-11 — while in fallback mode, `getSecret()` serves from cache first and skips the live call
 * entirely, EXCEPT it re-attempts a live call at most once every 30 seconds to detect recovery.
 * This library targets short-lived CI processes, so recovery detection is reactive (checked on
 * the next `getSecret()` call after the interval elapses) rather than a `setInterval` background
 * poller, which would keep the process alive indefinitely — an unacceptable side effect for a
 * CLI/CI-oriented package.
 */
export function shouldAttemptLiveRetry(state: FallbackState, now: number = Date.now()): boolean {
  if (!state.inFallback) return true
  return now - state.lastLiveRetryAt >= LIVE_RETRY_INTERVAL_MS
}

export function markLiveRetryAttempted(
  state: FallbackState,
  now: number = Date.now()
): FallbackState {
  state.lastLiveRetryAt = now
  return state
}
