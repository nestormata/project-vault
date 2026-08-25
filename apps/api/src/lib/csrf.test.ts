import { describe, expect, it } from 'vitest'
import { CSRF_HEADER_NAME, isRejectedByCsrfToken } from './csrf.js'

const TOKEN = 'a'.repeat(43)

describe('Story 25.6 AC1/AC2/AC8: isRejectedByCsrfToken()', () => {
  it('rejects when the CSRF cookie is missing entirely', () => {
    expect(isRejectedByCsrfToken(undefined, TOKEN)).toBe(true)
    expect(isRejectedByCsrfToken({}, TOKEN)).toBe(true)
  })

  it('rejects when the header is missing entirely', () => {
    expect(isRejectedByCsrfToken({ 'csrf-token': TOKEN }, undefined)).toBe(true)
  })

  it('rejects when the header value does not match the cookie value', () => {
    expect(isRejectedByCsrfToken({ 'csrf-token': TOKEN }, 'different-value')).toBe(true)
  })

  it('rejects when the cookie/header lengths differ (timing-safe comparison never throws)', () => {
    expect(isRejectedByCsrfToken({ 'csrf-token': TOKEN }, 'short')).toBe(true)
  })

  it('accepts when the header echoes the exact cookie value', () => {
    expect(isRejectedByCsrfToken({ 'csrf-token': TOKEN }, TOKEN)).toBe(false)
  })

  it('accepts the __Host- prefixed cookie name when the secure cookie policy is on', () => {
    expect(isRejectedByCsrfToken({ 'csrf-token': TOKEN }, TOKEN, true)).toBe(true)
    expect(isRejectedByCsrfToken({ '__Host-csrf-token': TOKEN }, TOKEN, true)).toBe(false)
  })

  it('reads only the first value of a multi-valued header, matching Sec-Fetch-Site precedent', () => {
    expect(isRejectedByCsrfToken({ 'csrf-token': TOKEN }, [TOKEN, 'other'])).toBe(false)
  })

  it('exports a stable, lower-cased header name for the client to echo', () => {
    expect(CSRF_HEADER_NAME).toBe('x-csrf-token')
  })
})
