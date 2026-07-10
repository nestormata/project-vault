import { afterEach, describe, expect, it } from 'vitest'
import { configureContractTestEnv } from './app-instance.js'

const originalRateLimitTestBypass = process.env['RATE_LIMIT_TEST_BYPASS']

afterEach(() => {
  if (originalRateLimitTestBypass === undefined) {
    delete process.env['RATE_LIMIT_TEST_BYPASS']
  } else {
    process.env['RATE_LIMIT_TEST_BYPASS'] = originalRateLimitTestBypass
  }
})

describe('configureContractTestEnv', () => {
  it('explicitly bypasses rate limiting for the high-volume contract sweep', () => {
    process.env['RATE_LIMIT_TEST_BYPASS'] = 'false'

    configureContractTestEnv()

    expect(process.env['RATE_LIMIT_TEST_BYPASS']).toBe('true')
  })
})
