import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  isKeyHashRateLimited,
  recordFailedKeyHashAttempt,
  resetKeyHashRateLimitStateForTest,
} from './token-exchange-rate-limit.js'

describe('token-exchange-rate-limit', () => {
  const originalNodeEnv = process.env['NODE_ENV']
  const originalBypass = process.env['RATE_LIMIT_TEST_BYPASS']

  beforeEach(() => {
    resetKeyHashRateLimitStateForTest()
  })

  afterEach(() => {
    resetKeyHashRateLimitStateForTest()
    if (originalNodeEnv === undefined) delete process.env['NODE_ENV']
    else process.env['NODE_ENV'] = originalNodeEnv
    if (originalBypass === undefined) delete process.env['RATE_LIMIT_TEST_BYPASS']
    else process.env['RATE_LIMIT_TEST_BYPASS'] = originalBypass
  })

  describe('isKeyHashRateLimited', () => {
    it('returns false immediately when rate limiting is not enforced, regardless of recorded attempts', () => {
      process.env['NODE_ENV'] = 'test'
      process.env['RATE_LIMIT_TEST_BYPASS'] = 'true'

      const keyHash = 'bypassed-hash'
      recordFailedKeyHashAttempt(keyHash)
      recordFailedKeyHashAttempt(keyHash)
      recordFailedKeyHashAttempt(keyHash)

      expect(isKeyHashRateLimited(keyHash, 1)).toBe(false)
    })

    it('returns false when there is no bucket yet for a keyHash (enforced)', () => {
      process.env['NODE_ENV'] = 'test'
      process.env['RATE_LIMIT_TEST_BYPASS'] = 'false'

      expect(isKeyHashRateLimited('never-seen-hash')).toBe(false)
    })

    it('returns false when a bucket exists but has already expired (enforced)', () => {
      process.env['NODE_ENV'] = 'test'
      process.env['RATE_LIMIT_TEST_BYPASS'] = 'false'

      const keyHash = 'expired-hash'
      recordFailedKeyHashAttempt(keyHash, -1)

      expect(isKeyHashRateLimited(keyHash)).toBe(false)
    })

    it('returns false when count is below max and true once count reaches max (enforced)', () => {
      process.env['NODE_ENV'] = 'test'
      process.env['RATE_LIMIT_TEST_BYPASS'] = 'false'

      const keyHash = 'below-then-at-max-hash'
      const max = 2

      recordFailedKeyHashAttempt(keyHash)
      expect(isKeyHashRateLimited(keyHash, max)).toBe(false)

      recordFailedKeyHashAttempt(keyHash)
      expect(isKeyHashRateLimited(keyHash, max)).toBe(true)
    })

    it('returns true once count exceeds max (enforced)', () => {
      process.env['NODE_ENV'] = 'test'
      process.env['RATE_LIMIT_TEST_BYPASS'] = 'false'

      const keyHash = 'exceeds-max-hash'
      const max = 2

      recordFailedKeyHashAttempt(keyHash)
      recordFailedKeyHashAttempt(keyHash)
      recordFailedKeyHashAttempt(keyHash)

      expect(isKeyHashRateLimited(keyHash, max)).toBe(true)
    })
  })

  describe('recordFailedKeyHashAttempt', () => {
    it('creates a bucket with count 1 on the first call, then increments to 2 within the same window', () => {
      process.env['NODE_ENV'] = 'test'
      process.env['RATE_LIMIT_TEST_BYPASS'] = 'false'

      const keyHash = 'increment-hash'
      const max = 2

      recordFailedKeyHashAttempt(keyHash, 60_000)
      expect(isKeyHashRateLimited(keyHash, max)).toBe(false)

      recordFailedKeyHashAttempt(keyHash, 60_000)
      expect(isKeyHashRateLimited(keyHash, max)).toBe(true)
    })

    it('resets count to 1 in a fresh window when the prior bucket has expired', () => {
      process.env['NODE_ENV'] = 'test'
      process.env['RATE_LIMIT_TEST_BYPASS'] = 'false'

      const keyHash = 'window-reset-hash'
      const max = 2

      // First attempt lands in an already-expired window (negative windowMs),
      // producing a bucket with resetAt in the past and count 1.
      recordFailedKeyHashAttempt(keyHash, -1)
      expect(isKeyHashRateLimited(keyHash, max)).toBe(false)

      // Recording again should hit the `!current || current.resetAt <= now` branch
      // via the expired-bucket sub-condition, resetting the count to 1 in a fresh
      // window rather than accumulating on top of the expired bucket's count.
      recordFailedKeyHashAttempt(keyHash, 60_000)
      expect(isKeyHashRateLimited(keyHash, max)).toBe(false)
    })
  })

  describe('resetKeyHashRateLimitStateForTest', () => {
    it('clears recorded attempts so a previously-limited keyHash returns to a clean false state', () => {
      process.env['NODE_ENV'] = 'test'
      process.env['RATE_LIMIT_TEST_BYPASS'] = 'false'

      const keyHash = 'reset-hash'
      const max = 2

      recordFailedKeyHashAttempt(keyHash)
      recordFailedKeyHashAttempt(keyHash)
      expect(isKeyHashRateLimited(keyHash, max)).toBe(true)

      resetKeyHashRateLimitStateForTest()

      expect(isKeyHashRateLimited(keyHash, max)).toBe(false)
    })
  })
})
