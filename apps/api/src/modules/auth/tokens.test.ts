import { describe, expect, it } from 'vitest'
import { env } from '../../config/env.js'
import {
  clearAuthCookies,
  csrfCookieName,
  generateCsrfToken,
  generatePendingMfaToken,
  generateRefreshToken,
  hashPendingMfaToken,
  hashRefreshToken,
  refreshTokensMatch,
  setAuthCookies,
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

  it('scopes refresh cookies to app routes so SSR route guards can refresh sessions', () => {
    const setCookie = new Map<string, Record<string, unknown>>()
    const clearCookie = new Map<string, Record<string, unknown>>()

    setAuthCookies(
      {
        setCookie: (name, _value, options) => setCookie.set(name, options),
        clearCookie: (name, options) => clearCookie.set(name, options),
      },
      {
        accessJwt: 'access-token',
        refreshOpaque: OPAQUE_REFRESH_TOKEN,
        accessMaxAgeSec: 300,
        refreshMaxAgeSec: 3600,
      }
    )
    clearAuthCookies({
      setCookie: () => undefined,
      clearCookie: (name, options) => clearCookie.set(name, options),
    })

    expect(setCookie.get('refresh-token')?.['path']).toBe('/')
    expect(clearCookie.get('refresh-token')?.['path']).toBe('/')
  })
})

describe('Story 25.6 AC1/AC5/AC7: CSRF double-submit-cookie token helpers', () => {
  it('generates opaque base64url CSRF tokens, distinct on every call', () => {
    const token = generateCsrfToken()
    const otherToken = generateCsrfToken()

    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(token.length).toBeGreaterThanOrEqual(43)
    expect(otherToken).not.toBe(token)
  })

  it('AC7: uses the __Host- prefix only when the cookie policy is secure, since __Host- requires Secure', () => {
    expect(csrfCookieName(true)).toBe('__Host-csrf-token')
    expect(csrfCookieName(false)).toBe('csrf-token')
  })

  it('AC1/AC5: issues a non-httpOnly CSRF cookie at the SAME point the session cookie itself is set, with the same strict/secure/path attributes', () => {
    const setCookie = new Map<string, Record<string, unknown>>()

    setAuthCookies(
      {
        setCookie: (name, _value, options) => setCookie.set(name, options),
        clearCookie: () => undefined,
      },
      {
        accessJwt: 'access-token',
        refreshOpaque: OPAQUE_REFRESH_TOKEN,
        accessMaxAgeSec: 300,
        refreshMaxAgeSec: 3600,
      }
    )

    const csrfCookie = setCookie.get(csrfCookieName(env.COOKIE_SECURE))
    expect(csrfCookie).toBeDefined()
    expect(csrfCookie?.['httpOnly']).toBe(false)
    expect(csrfCookie?.['sameSite']).toBe('strict')
    expect(csrfCookie?.['secure']).toBe(env.COOKIE_SECURE)
    expect(csrfCookie?.['path']).toBe('/')
    expect(csrfCookie?.['maxAge']).toBe(300)
  })

  it('AC1: clearAuthCookies also clears the CSRF cookie, consistent with session-lifecycle invalidation', () => {
    const clearCookie = new Map<string, Record<string, unknown>>()

    clearAuthCookies({
      setCookie: () => undefined,
      clearCookie: (name, options) => clearCookie.set(name, options),
    })

    const csrfClear = clearCookie.get(csrfCookieName(env.COOKIE_SECURE))
    expect(csrfClear).toBeDefined()
    expect(csrfClear?.['path']).toBe('/')
    // Code review fix: a `__Host-`-prefixed cookie can only ever be cleared with a `Secure`
    // Set-Cookie header — the browser silently drops the clearing header otherwise, leaving the
    // CSRF cookie alive past logout. Pin that the clear call always carries the matching `secure`
    // attribute the cookie itself was originally set with.
    expect(csrfClear?.['secure']).toBe(env.COOKIE_SECURE)
    // Invariant regardless of the current environment's COOKIE_SECURE value: whenever the cookie
    // being cleared carries the `__Host-` prefix, the clearing Set-Cookie MUST also be `secure`,
    // since a `__Host-`-prefixed Set-Cookie header without `Secure` is invalid and browsers
    // silently drop it — meaning logout would never actually clear the cookie.
    if (csrfCookieName(env.COOKIE_SECURE).startsWith('__Host-')) {
      expect(csrfClear?.['secure']).toBe(true)
    }
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
