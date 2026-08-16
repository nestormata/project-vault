/**
 * Shared bounded-retry "poll a URL until it responds ok" helper (jscpd gate) — extracted from
 * `global-setup.ts`'s `waitForReady()` and `isolated-envelope-stack.ts`'s `waitForHttp()`, which
 * duplicated the same retry loop with different attempt/delay defaults and error-message shapes.
 * Both callers keep their own defaults and error-message wording by passing them explicitly.
 */
export async function pollUntilOk(
  url: string,
  options: { attempts: number; delayMs: number; onExhausted: (lastError: unknown) => Error }
): Promise<void> {
  let lastError: unknown
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      const response = await fetch(url)
      if (response.ok) return
      lastError = new Error(`${url} responded with ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, options.delayMs))
  }
  throw options.onExhausted(lastError)
}
