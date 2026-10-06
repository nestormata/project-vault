import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  USER_RATE_LIMIT_MAX_BUCKETS,
  consumeUserRateLimit,
  enforceUserRateLimit,
  userRateLimitBucketCount,
} from './route-helpers.js'

/**
 * Story 71.9 AC-4: `consumeUserRateLimit` is the reply-free core of `enforceUserRateLimit`, so a
 * caller can spend a bucket without sending a 429 (the per-kid check before a security event, the
 * delegated per-IP limiter). Buckets are now bounded, because a per-IP key is attacker-chosen.
 */

const ORIGINAL_BYPASS = process.env['RATE_LIMIT_TEST_BYPASS']

beforeEach(() => {
  process.env['RATE_LIMIT_TEST_BYPASS'] = 'false'
})

afterEach(() => {
  vi.useRealTimers()
  if (ORIGINAL_BYPASS === undefined) delete process.env['RATE_LIMIT_TEST_BYPASS']
  else process.env['RATE_LIMIT_TEST_BYPASS'] = ORIGINAL_BYPASS
})

describe('consumeUserRateLimit (Story 71.9)', () => {
  it('allows up to max, then denies with a positive retryAfter, without any reply', () => {
    const input = { userId: 'consume-a', key: 'k', max: 2, timeWindowMs: 60_000 }
    expect(consumeUserRateLimit(input)).toEqual({ allowed: true })
    expect(consumeUserRateLimit(input)).toEqual({ allowed: true })
    const denied = consumeUserRateLimit(input)
    expect(denied.allowed).toBe(false)
    expect(denied.allowed === false && denied.retryAfter).toBeGreaterThan(0)
  })

  it('starts a fresh window once the previous one expired', () => {
    vi.useFakeTimers()
    const input = { userId: 'consume-b', key: 'k', max: 1, timeWindowMs: 1_000 }
    expect(consumeUserRateLimit(input).allowed).toBe(true)
    expect(consumeUserRateLimit(input).allowed).toBe(false)
    vi.advanceTimersByTime(1_001)
    expect(consumeUserRateLimit(input).allowed).toBe(true)
  })

  it('always allows when the bypass is on, exactly like the other limiters', () => {
    process.env['NODE_ENV'] = 'test'
    process.env['RATE_LIMIT_TEST_BYPASS'] = 'true'
    const input = { userId: 'consume-c', key: 'k', max: 1, timeWindowMs: 60_000 }
    expect(consumeUserRateLimit(input).allowed).toBe(true)
    expect(consumeUserRateLimit(input).allowed).toBe(true)
  })

  it('stays bounded when an attacker sprays distinct keys', () => {
    for (let index = 0; index <= USER_RATE_LIMIT_MAX_BUCKETS + 10; index += 1) {
      consumeUserRateLimit({
        userId: `spray-${index}`,
        key: 'k',
        max: 5,
        timeWindowMs: 60_000,
        bounded: true,
      })
    }
    expect(userRateLimitBucketCount(true)).toBeLessThanOrEqual(USER_RATE_LIMIT_MAX_BUCKETS)
  })

  it('a bounded spray never evicts the windows of the other limiters', () => {
    const victim = { userId: 'victim-kid', key: 'k', max: 1, timeWindowMs: 60_000 }
    expect(consumeUserRateLimit(victim).allowed).toBe(true)
    for (let index = 0; index <= USER_RATE_LIMIT_MAX_BUCKETS + 10; index += 1) {
      consumeUserRateLimit({
        userId: `flood-${index}`,
        key: 'k',
        max: 5,
        timeWindowMs: 60_000,
        bounded: true,
      })
    }
    expect(consumeUserRateLimit(victim).allowed).toBe(false)
  })
})

describe('enforceUserRateLimit keeps its reply behaviour (Story 71.9 refactor)', () => {
  it('sends the 429 body and Retry-After once over the limit', () => {
    const sent: unknown[] = []
    const headers: Array<[string, string]> = []
    const reply = {
      header: (name: string, value: string) => {
        headers.push([name, value])
        return reply
      },
      status: (code: number) => {
        sent.push(code)
        return reply
      },
      send: (body: unknown) => {
        sent.push(body)
        return reply
      },
    }
    const input = {
      userId: 'enforce-a',
      key: 'k',
      max: 1,
      timeWindowMs: 60_000,
      reply: reply as never,
      retryAfterHeader: true,
    }
    expect(enforceUserRateLimit(input)).toBe(true)
    expect(enforceUserRateLimit(input)).toBe(false)
    expect(sent[0]).toBe(429)
    expect(sent[1]).toMatchObject({ code: 'rate_limit_exceeded' })
    expect(headers[0]?.[0]).toBe('Retry-After')
  })
})
