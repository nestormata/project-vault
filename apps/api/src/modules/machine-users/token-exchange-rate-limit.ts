import { isRateLimitEnforced } from '../../lib/route-helpers.js'

// AC-4 — a second, key-hash-scoped rate-limit bucket independent of the IP-based one
// (`secureRoute`'s built-in public-route limiter already covers the IP bucket). This bucket only
// defends against repeated verification attempts against ONE already-known, already-fabricated-
// or-leaked exact key string — see AC-4's Dev Notes on what this bucket does and does not defend
// against. Deliberately NOT reset by a successful exchange with a different key.
const failedAttemptWindows = new Map<string, { count: number; resetAt: number }>()

export const KEY_HASH_FAILED_ATTEMPT_MAX = 10
export const KEY_HASH_FAILED_ATTEMPT_WINDOW_MS = 60_000

/**
 * Peeks whether `keyHash` has already hit its failed-attempt budget for the current window,
 * without incrementing anything — called BEFORE the (comparatively expensive) `apiKeysMatch()`
 * comparison so an already-flagged hash short-circuits to 429 without burning comparison cycles.
 */
export function isKeyHashRateLimited(
  keyHash: string,
  max: number = KEY_HASH_FAILED_ATTEMPT_MAX
): boolean {
  if (!isRateLimitEnforced()) return false
  const bucket = failedAttemptWindows.get(keyHash)
  if (!bucket || bucket.resetAt <= Date.now()) return false
  return bucket.count >= max
}

/** Records one failed exchange attempt against `keyHash`, starting a fresh window if needed. */
export function recordFailedKeyHashAttempt(
  keyHash: string,
  windowMs: number = KEY_HASH_FAILED_ATTEMPT_WINDOW_MS
): void {
  const now = Date.now()
  const current = failedAttemptWindows.get(keyHash)
  const bucket =
    !current || current.resetAt <= now ? { count: 0, resetAt: now + windowMs } : current
  bucket.count += 1
  failedAttemptWindows.set(keyHash, bucket)
}

/** Test-only reset so suites don't leak rate-limit state across cases. */
export function resetKeyHashRateLimitStateForTest(): void {
  failedAttemptWindows.clear()
}
