import { describe, expect, it } from 'vitest'
import { env } from '../../config/env.js'
import {
  generatePendingMfaToken,
  generateRefreshToken,
  hashPendingMfaToken,
  hashRefreshToken,
  refreshTokensMatch,
} from './tokens.js'

const OPAQUE_REFRESH_TOKEN = 'opaque-refresh-token'
const OPAQUE_MFA_TOKEN = 'opaque-mfa-token'

describe('refresh token helpers', () => {
  it('generates opaque base64url refresh tokens', () => {
    const token = generateRefreshToken()

    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(token.length).toBeGreaterThanOrEqual(43)
  })

  it('hashes refresh tokens with deterministic HMAC output', () => {
    const hash = hashRefreshToken(OPAQUE_REFRESH_TOKEN)

    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hash).toBe(hashRefreshToken(OPAQUE_REFRESH_TOKEN))
    expect(hash).not.toBe(OPAQUE_REFRESH_TOKEN)
  })

  it('matches refresh tokens without accepting mismatches', () => {
    const hash = hashRefreshToken(OPAQUE_REFRESH_TOKEN)

    expect(refreshTokensMatch(hash, OPAQUE_REFRESH_TOKEN)).toBe(true)
    expect(refreshTokensMatch(hash, 'other-refresh-token')).toBe(false)
    expect(refreshTokensMatch('short', OPAQUE_REFRESH_TOKEN)).toBe(false)
    expect(refreshTokensMatch('z'.repeat(64), OPAQUE_REFRESH_TOKEN)).toBe(false)
  })
})

describe('pending MFA login token helpers', () => {
  it('generates opaque 128-bit base64url pending MFA tokens', () => {
    const token = generatePendingMfaToken()
    const otherToken = generatePendingMfaToken()

    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(otherToken).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(otherToken).not.toBe(token)
  })

  it('hashes pending MFA tokens with deterministic dedicated HMAC output', () => {
    const originalSecret = env.MFA_PENDING_SESSION_HMAC_SECRET
    try {
      env.MFA_PENDING_SESSION_HMAC_SECRET = 'd'.repeat(64)
      const hash = hashPendingMfaToken(OPAQUE_MFA_TOKEN)

      expect(hash).toMatch(/^[0-9a-f]{64}$/)
      expect(hash).toBe(hashPendingMfaToken(OPAQUE_MFA_TOKEN))
      expect(hash).not.toBe(OPAQUE_MFA_TOKEN)

      env.MFA_PENDING_SESSION_HMAC_SECRET = 'e'.repeat(64)
      expect(hashPendingMfaToken(OPAQUE_MFA_TOKEN)).not.toBe(hash)
    } finally {
      env.MFA_PENDING_SESSION_HMAC_SECRET = originalSecret
    }
  })
})
