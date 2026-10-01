import { setTimeout as delay } from 'node:timers/promises'

/** One poll: undefined when the URL answered ok, else the error to report if polling runs out. */
async function pollOnce(url: string, signal: AbortSignal | undefined): Promise<unknown> {
  try {
    const response = await fetch(url, { signal })
    return response.ok ? undefined : new Error(`${url} responded with ${response.status}`)
  } catch (error) {
    return error ?? new Error(`${url} failed`)
  }
}

/** Waits `ms`, returning early (without throwing) if `signal` aborts. */
async function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  try {
    await delay(ms, undefined, { signal })
  } catch {
    // Aborted mid-delay: the caller's aborted check ends the loop.
  }
}

/**
 * Shared bounded-retry "poll a URL until it responds ok" helper (jscpd gate) — extracted from
 * `global-setup.ts`'s `waitForReady()` and `isolated-envelope-stack.ts`'s `waitForHttp()`, which
 * duplicated the same retry loop with different attempt/delay defaults and error-message shapes.
 * Both callers keep their own defaults and error-message wording by passing them explicitly.
 *
 * Story 66.4 AC-7: an optional `signal` stops the loop early (the caller no longer cares, e.g. the
 * polled process already exited): it then resolves quietly, leaving no timer or rejection behind.
 */
export async function pollUntilOk(url: string, options: PollOptions): Promise<void> {
  const outcome = await pollRemaining(url, options, options.attempts, undefined)
  if (outcome.done) return
  throw options.onExhausted(outcome.lastError)
}

interface PollOptions {
  attempts: number
  delayMs: number
  onExhausted: (lastError: unknown) => Error
  signal?: AbortSignal
}

type PollOutcome = { done: true } | { done: false; lastError: unknown }

/**
 * Each attempt chains the next one (strictly sequential: an attempt must finish and wait before the
 * next starts). `done` means answered ok or aborted; otherwise the budget ran out.
 */
async function pollRemaining(
  url: string,
  options: PollOptions,
  remaining: number,
  lastError: unknown
): Promise<PollOutcome> {
  const { signal } = options
  if (signal?.aborted) return { done: true }
  if (remaining <= 0) return { done: false, lastError }
  const error = await pollOnce(url, signal)
  if (error === undefined || signal?.aborted) return { done: true }
  await pause(options.delayMs, signal)
  return pollRemaining(url, options, remaining - 1, error)
}
