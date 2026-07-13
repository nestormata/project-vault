import { describe, expect, it } from 'vitest'
import { generateOpaqueToken, hashOpaqueToken, opaqueTokenMatches } from './opaque-token.js'

const SECRET = 'test-secret'

describe('opaque token', () => {
  it('generateOpaqueToken produces a URL-safe, non-empty opaque token', () => {
    const token = generateOpaqueToken()
    expect(token.length).toBeGreaterThan(0)
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(generateOpaqueToken()).not.toBe(token)
  })

  it('generateOpaqueToken respects a custom byteLength', () => {
    const defaultToken = generateOpaqueToken()
    const shortToken = generateOpaqueToken(8)
    const longToken = generateOpaqueToken(64)
    expect(shortToken.length).toBeLessThan(defaultToken.length)
    expect(longToken.length).toBeGreaterThan(defaultToken.length)
  })

  it('hashOpaqueToken is a deterministic 64-char hex HMAC of secret and opaque value', () => {
    const opaque = generateOpaqueToken()
    const hash = hashOpaqueToken(SECRET, opaque)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hashOpaqueToken(SECRET, opaque)).toBe(hash)
  })

  it('opaqueTokenMatches rejects a stored hash that is not 64 hex characters', () => {
    expect(opaqueTokenMatches(SECRET, 'not-a-hash', 'anything')).toBe(false)
  })

  it('opaqueTokenMatches returns true when the opaque token hashes to the stored hash', () => {
    const opaque = generateOpaqueToken()
    const stored = hashOpaqueToken(SECRET, opaque)
    expect(opaqueTokenMatches(SECRET, stored, opaque)).toBe(true)
  })

  it('opaqueTokenMatches returns false when the opaque token hashes to a different value', () => {
    const opaque = generateOpaqueToken()
    const stored = hashOpaqueToken(SECRET, generateOpaqueToken())
    expect(opaqueTokenMatches(SECRET, stored, opaque)).toBe(false)
  })

  it('opaqueTokenMatches returns false when the secret differs', () => {
    const opaque = generateOpaqueToken()
    const stored = hashOpaqueToken(SECRET, opaque)
    expect(opaqueTokenMatches('different-secret', stored, opaque)).toBe(false)
  })
})
