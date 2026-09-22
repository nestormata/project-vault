/**
 * Dev Notes decision #5 (offline-cache participation) + AC-4a — `pv get` participates in
 * packages/agent's default offline-cache fallback (its own default `cachePath`/
 * `fallbackThreshold` are left untouched, exactly as documented in packages/agent/README.md), but
 * a served-from-cache value must be signaled on stderr, never silent (AC-4a).
 *
 * packages/agent's public `getSecret(name): Promise<string>` has no provenance field — a
 * successful resolution looks identical whether it came from a live fetch or the cache fallback.
 * Rather than modifying packages/agent (out of this story's scope — AC-1 keeps it a thin,
 * unmodified dependency), this observes the one reliable, already-documented signal packages/
 * agent itself relies on internally: a network-level failure (connection refused, DNS failure,
 * timeout) surfaces as a `TypeError` from the global `fetch()` (see packages/agent/src/index.ts's
 * own "AC-11" comment) and is the ONLY condition under which `getSecret()` ever falls back to a
 * cached value instead of a live one. This wraps `globalThis.fetch` for the duration of a single
 * `getSecret()` call, observes whether any such TypeError occurred, and restores the original
 * `fetch` afterwards — a scoped, self-contained detection with no packages/agent modification.
 */
export async function withFetchProvenanceTracking<T>(
  fn: () => Promise<T>
): Promise<{ result: T; servedAfterNetworkFailure: boolean }> {
  const originalFetch = globalThis.fetch
  let networkFailureObserved = false

  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    try {
      return await originalFetch(...args)
    } catch (error) {
      if (error instanceof TypeError) networkFailureObserved = true
      throw error
    }
  }) as typeof fetch

  try {
    const result = await fn()
    return { result, servedAfterNetworkFailure: networkFailureObserved }
  } finally {
    globalThis.fetch = originalFetch
  }
}
