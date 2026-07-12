import { describe, expect, it } from 'vitest'
import { hashOriginalEmail } from './erasure-service.js'

const USER_EMAIL = 'user@example.com'

describe('hashOriginalEmail', () => {
  it('produces a deterministic 64-hex-char HMAC-SHA256 digest', () => {
    const hash = hashOriginalEmail(USER_EMAIL)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hashOriginalEmail(USER_EMAIL)).toBe(hash)
  })

  it('normalizes the email before hashing (case-insensitive)', () => {
    expect(hashOriginalEmail('User@Example.com')).toBe(hashOriginalEmail(USER_EMAIL))
  })

  it('produces different hashes for different emails', () => {
    expect(hashOriginalEmail('a@example.com')).not.toBe(hashOriginalEmail('b@example.com'))
  })
})
