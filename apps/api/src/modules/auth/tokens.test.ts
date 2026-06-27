import { describe, expect, it } from 'vitest'
import { generateRefreshToken, hashRefreshToken, refreshTokensMatch } from './tokens.js'

const OPAQUE_REFRESH_TOKEN = 'opaque-refresh-token'

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
