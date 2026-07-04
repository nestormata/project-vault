import { describe, expect, it } from 'vitest'
import { env } from '../../config/env.js'
import { apiKeysMatch, generateApiKey, hashApiKey } from './tokens.js'

const PLAINTEXT_A = 'pk_9f3aB7xQsomefixedplaceholdervaluefortest'

describe('generateApiKey', () => {
  it('generates a pk_-prefixed 256-bit base64url key (D2)', () => {
    const key = generateApiKey()

    expect(key.startsWith('pk_')).toBe(true)
    // pk_ (3 chars) + unpadded base64url of 32 bytes (43 chars) = 46 chars total.
    expect(key.length).toBe(46)
    expect(key.slice(3)).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('generates distinct keys on each call', () => {
    expect(generateApiKey()).not.toBe(generateApiKey())
  })
})

describe('hashApiKey', () => {
  it('hashes API keys with deterministic HMAC-SHA256 output (D1)', () => {
    const hash = hashApiKey(PLAINTEXT_A)

    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hash).toBe(hashApiKey(PLAINTEXT_A))
    expect(hash).not.toBe(PLAINTEXT_A)
  })

  it('produces different hashes for different plaintext keys', () => {
    expect(hashApiKey(PLAINTEXT_A)).not.toBe(hashApiKey(generateApiKey()))
  })

  it('uses a dedicated secret, distinct from other HMAC secrets in the app', () => {
    const originalSecret = env.API_KEY_HMAC_SECRET
    try {
      env.API_KEY_HMAC_SECRET = 'g'.repeat(64)
      const hash = hashApiKey(PLAINTEXT_A)
      env.API_KEY_HMAC_SECRET = 'h'.repeat(64)
      expect(hashApiKey(PLAINTEXT_A)).not.toBe(hash)
    } finally {
      env.API_KEY_HMAC_SECRET = originalSecret
    }
  })
})

describe('apiKeysMatch', () => {
  it('matches a stored hash against the correct plaintext', () => {
    const hash = hashApiKey(PLAINTEXT_A)
    expect(apiKeysMatch(hash, PLAINTEXT_A)).toBe(true)
  })

  it('rejects an incorrect plaintext', () => {
    const hash = hashApiKey(PLAINTEXT_A)
    expect(apiKeysMatch(hash, generateApiKey())).toBe(false)
  })

  it('rejects a malformed stored hash rather than throwing', () => {
    expect(apiKeysMatch('not-a-hex-hash', PLAINTEXT_A)).toBe(false)
    expect(apiKeysMatch('z'.repeat(64), PLAINTEXT_A)).toBe(false)
  })
})
