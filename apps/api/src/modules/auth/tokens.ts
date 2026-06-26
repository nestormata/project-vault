import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { env } from '../../config/env.js'

export type AuthCookieTokens = {
  accessJwt: string
  refreshOpaque: string
  accessMaxAgeSec: number
  refreshMaxAgeSec: number
}

export type CookieReply = {
  setCookie: (name: string, value: string, options: Record<string, unknown>) => void
  clearCookie: (name: string, options: Record<string, unknown>) => void
}

export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashRefreshToken(opaque: string): string {
  return createHmac('sha256', env.REFRESH_TOKEN_HMAC_SECRET).update(opaque).digest('hex')
}

export function refreshTokensMatch(storedHash: string, opaque: string): boolean {
  const computed = hashRefreshToken(opaque)
  if (storedHash.length !== computed.length) return false
  return timingSafeEqual(Buffer.from(storedHash, 'hex'), Buffer.from(computed, 'hex'))
}

export function setAuthCookies(reply: CookieReply, tokens: AuthCookieTokens): void {
  const secure = env.COOKIE_SECURE
  reply.setCookie('access-token', tokens.accessJwt, {
    httpOnly: true,
    sameSite: 'strict',
    secure,
    path: '/',
    maxAge: tokens.accessMaxAgeSec,
  })
  reply.setCookie('refresh-token', tokens.refreshOpaque, {
    httpOnly: true,
    sameSite: 'strict',
    secure,
    path: '/api/v1/auth/refresh',
    maxAge: tokens.refreshMaxAgeSec,
  })
}

export function clearAuthCookies(reply: CookieReply): void {
  reply.clearCookie('access-token', { path: '/' })
  reply.clearCookie('refresh-token', { path: '/api/v1/auth/refresh' })
}
