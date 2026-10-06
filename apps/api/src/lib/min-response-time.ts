/**
 * Story 65.4 — deadline-style minimum response time, shared by every anonymous path whose
 * "this link does not work" outcomes must not be told apart by latency.
 *
 * The hold is a deadline measured from when the work STARTED, not a fixed extra delay: work that
 * already took longer than the minimum gets no further wait, and the wait is never unbounded
 * (callers pass a constant, capped well under any request timeout). It is a timer, never a busy
 * wait. Random jitter is deliberately not used: it would not remove a difference between class
 * medians, which is exactly what a median-based timing test detects.
 */

/** Monotonic clock in milliseconds, unaffected by wall-clock adjustments. */
export function monotonicNowMs(): number {
  return performance.now()
}

/** Resolves once `minMs` milliseconds have passed since `startedAtMs` (resolves immediately when
 *  they already have). */
export function holdUntilMinResponse(startedAtMs: number, minMs: number): Promise<void> {
  const remaining = startedAtMs + minMs - monotonicNowMs()
  if (remaining <= 0) return Promise.resolve()
  return new Promise((resolve) => {
    setTimeout(resolve, remaining)
  })
}

export type MinResponseOptions<T> = {
  /** True when the produced value is a "miss" outcome that must be held. */
  isMiss: (value: T) => boolean
  /** True when a thrown error is itself a class-correlated outcome that must be held before it
   *  propagates (e.g. a per-org rate-limit rejection). Any other error propagates immediately. */
  isMissError?: (error: unknown) => boolean
}

/**
 * Runs `work` and holds a miss outcome until `minMs` after it started. A success is returned as
 * soon as it is ready. An error that `isMissError` accepts is held and then rethrown; every other
 * error propagates unheld (an error is not a miss, and holding it would only slow failure
 * detection).
 */
export async function withMinResponseTime<T>(
  minMs: number,
  work: () => Promise<T>,
  options: MinResponseOptions<T>
): Promise<T> {
  const startedAt = monotonicNowMs()
  let value: T
  try {
    value = await work()
  } catch (error) {
    if (options.isMissError?.(error)) await holdUntilMinResponse(startedAt, minMs)
    throw error
  }
  if (options.isMiss(value)) await holdUntilMinResponse(startedAt, minMs)
  return value
}
