import { describe, expect, it } from 'vitest'
import {
  generateStatusPageToken,
  hashStatusPageToken,
  statusPageTokenMatches,
} from './status-page-tokens.js'

// Story 6.3 ADR-6.3-06: reuses opaque-token.ts verbatim via a thin wrapper mirroring
// recovery-tokens.ts's exact shape.
describe('status page token helpers', () => {
  it('generates opaque base64url tokens with at least 128 bits of entropy (22+ chars)', () => {
    const token = generateStatusPageToken()

    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(token.length).toBeGreaterThan(32)
  })

  it('generates unique tokens across calls', () => {
    const a = generateStatusPageToken()
    const b = generateStatusPageToken()

    expect(a).not.toEqual(b)
  })

  it('hashes deterministically for the same opaque token', () => {
    const token = generateStatusPageToken()

    expect(hashStatusPageToken(token)).toEqual(hashStatusPageToken(token))
    expect(hashStatusPageToken(token)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('produces different hashes for different tokens', () => {
    expect(hashStatusPageToken('token-a')).not.toEqual(hashStatusPageToken('token-b'))
  })

  describe('statusPageTokenMatches', () => {
    it('returns true for a matching opaque token/hash pair', () => {
      const token = generateStatusPageToken()
      const hash = hashStatusPageToken(token)

      expect(statusPageTokenMatches(hash, token)).toBe(true)
    })

    it('returns false for a mismatched token', () => {
      const token = generateStatusPageToken()
      const hash = hashStatusPageToken(token)

      expect(statusPageTokenMatches(hash, `${token}x`)).toBe(false)
    })

    it('returns false for a malformed stored hash instead of throwing', () => {
      expect(statusPageTokenMatches('not-a-hex-hash', 'anything')).toBe(false)
    })
  })
})
