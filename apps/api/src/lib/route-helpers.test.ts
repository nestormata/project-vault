import { afterEach, describe, expect, it } from 'vitest'
import { isRateLimitEnforced, validationError } from './route-helpers.js'

const ORIGINAL_NODE_ENV = process.env['NODE_ENV']
const ORIGINAL_RATE_LIMIT_TEST_BYPASS = process.env['RATE_LIMIT_TEST_BYPASS']

afterEach(() => {
  if (ORIGINAL_NODE_ENV === undefined) {
    delete process.env['NODE_ENV']
  } else {
    process.env['NODE_ENV'] = ORIGINAL_NODE_ENV
  }

  if (ORIGINAL_RATE_LIMIT_TEST_BYPASS === undefined) {
    delete process.env['RATE_LIMIT_TEST_BYPASS']
  } else {
    process.env['RATE_LIMIT_TEST_BYPASS'] = ORIGINAL_RATE_LIMIT_TEST_BYPASS
  }
})

describe('isRateLimitEnforced', () => {
  it('keeps rate limiting enforced by default even under NODE_ENV=test', () => {
    process.env['NODE_ENV'] = 'test'
    delete process.env['RATE_LIMIT_TEST_BYPASS']

    expect(isRateLimitEnforced()).toBe(true)
  })

  it('disables rate limiting only when NODE_ENV=test and RATE_LIMIT_TEST_BYPASS=true', () => {
    process.env['NODE_ENV'] = 'test'
    process.env['RATE_LIMIT_TEST_BYPASS'] = 'true'

    expect(isRateLimitEnforced()).toBe(false)
  })

  it('keeps rate limiting enforced when the bypass flag leaks outside test', () => {
    process.env['NODE_ENV'] = 'production'
    process.env['RATE_LIMIT_TEST_BYPASS'] = 'true'

    expect(isRateLimitEnforced()).toBe(true)
  })
})

describe('validationError', () => {
  // Story 1.21 AC-1/Task 3: password_too_weak joins invalid_cron/invalid_link_url/
  // invalid_domain_format in the message-to-code special-casing convention.
  it('maps a password_too_weak refine message to the password_too_weak code', () => {
    const result = validationError(
      { issues: [{ path: ['password'], message: 'password_too_weak' }] },
      'body'
    )
    expect(result.code).toBe('password_too_weak')
  })

  it('falls back to the generic validation_error code for unrecognized messages', () => {
    const result = validationError(
      { issues: [{ path: ['email'], message: 'Invalid email' }] },
      'body'
    )
    expect(result.code).toBe('validation_error')
  })
})
