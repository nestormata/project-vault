import { describe, expect, it } from 'vitest'
import { parseRetryAfter, retryAfterFromResponse, retryDelayPhrase } from './retry-after.js'

describe('parseRetryAfter (Story 43.8 AC-7) — strict integer seconds, clamped, never echoed', () => {
  it.each([
    ['37', 37],
    ['1', 1],
    ['0', 1],
    ['60', 60],
    ['3600', 3600],
    ['99999', 3600],
  ])('accepts %j as %i seconds', (raw, expected) => {
    expect(parseRetryAfter(raw)).toBe(expected)
  })

  it.each([
    null,
    undefined,
    '',
    ' 37',
    '37 ',
    '-5',
    '1e9',
    '3.5',
    '123456',
    '37; rm -rf /',
    '\u001b[31m37',
    'Wed, 21 Oct 2026 07:28:00 GMT',
  ])('rejects %j as null (the "later" wording)', (raw) => {
    expect(parseRetryAfter(raw)).toBeNull()
  })
})

describe('retryAfterFromResponse', () => {
  it('reads the Retry-After header of a real Response', () => {
    const response = new Response('{}', { status: 429, headers: { 'retry-after': '12' } })
    expect(retryAfterFromResponse(response)).toBe(12)
  })

  it('returns null for a Response without the header (e.g. a proxy HTML 429)', () => {
    expect(retryAfterFromResponse(new Response('<html>busy</html>', { status: 429 }))).toBeNull()
  })

  it('returns null for a header-less response-like object', () => {
    expect(retryAfterFromResponse({ status: 429 } as Response)).toBeNull()
  })
})

describe('retryDelayPhrase', () => {
  it('renders seconds, singular and plural, or "later"', () => {
    expect(retryDelayPhrase(37)).toBe('in 37 seconds')
    expect(retryDelayPhrase(1)).toBe('in 1 second')
    expect(retryDelayPhrase(null)).toBe('later')
  })
})
