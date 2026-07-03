import { describe, expect, it } from 'vitest'
import {
  generateRecoveryToken,
  hashRecoveryToken,
  maskRecoveryEmail,
  recoveryTokensMatch,
} from './recovery-tokens.js'

describe('recovery token helpers', () => {
  it('generates opaque base64url recovery tokens', () => {
    const token = generateRecoveryToken()

    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(token.length).toBeGreaterThan(32)
  })

  it('generates unique tokens across calls', () => {
    const a = generateRecoveryToken()
    const b = generateRecoveryToken()

    expect(a).not.toEqual(b)
  })

  it('hashes deterministically for the same opaque token', () => {
    const token = generateRecoveryToken()

    expect(hashRecoveryToken(token)).toEqual(hashRecoveryToken(token))
    expect(hashRecoveryToken(token)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('produces different hashes for different tokens', () => {
    expect(hashRecoveryToken('token-a')).not.toEqual(hashRecoveryToken('token-b'))
  })

  describe('recoveryTokensMatch', () => {
    it('returns true for a matching opaque token/hash pair', () => {
      const token = generateRecoveryToken()
      const hash = hashRecoveryToken(token)

      expect(recoveryTokensMatch(hash, token)).toBe(true)
    })

    it('returns false for a mismatched token', () => {
      const token = generateRecoveryToken()
      const hash = hashRecoveryToken(token)

      expect(recoveryTokensMatch(hash, `${token}x`)).toBe(false)
    })

    it('returns false for a malformed stored hash instead of throwing', () => {
      expect(recoveryTokensMatch('not-a-hex-hash', 'anything')).toBe(false)
    })
  })

  describe('maskRecoveryEmail', () => {
    it('keeps the first two local-part characters for a long local part', () => {
      expect(maskRecoveryEmail('alex@example.com')).toBe('al***@example.com')
    })

    it('keeps a single character for a short local part', () => {
      expect(maskRecoveryEmail('al@example.com')).toBe('a***@example.com')
    })

    it('keeps a single character for a one-character local part', () => {
      expect(maskRecoveryEmail('a@example.com')).toBe('a***@example.com')
    })

    it('leaves the domain untouched', () => {
      expect(maskRecoveryEmail('someone@sub.example.co.uk')).toBe('so***@sub.example.co.uk')
    })
  })
})
