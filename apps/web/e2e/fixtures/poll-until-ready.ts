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
export async function pollUntilOk(
  url: string,
  options: {
    attempts: number
    delayMs: number
    onExhausted: (lastError: unknown) => Error
    signal?: AbortSignal
  }
): Promise<void> {
  const { signal } = options
  let lastError: unknown
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    if (signal?.aborted) return
    lastError = await pollOnce(url, signal)
    if (lastError === undefined || signal?.aborted) return
    await pause(options.delayMs, signal)
  }
  if (signal?.aborted) return
  throw options.onExhausted(lastError)
}
