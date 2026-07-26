import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { env } from '../../config/env.js'

export type AuthCookieTokens = {
  accessJwt: string
  refreshOpaque?: string
  accessMaxAgeSec: number
  refreshMaxAgeSec: number
}

export type CookieReply = {
  setCookie: (name: string, value: string, options: Record<string, unknown>) => void
  clearCookie: (name: string, options: Record<string, unknown>) => void
}

export type AccessTokenClaims = {
  sub: string
  orgId: string
  jti: string
  sessionVersion: number
  iat?: number
  exp?: number
}

export function parseAccessTokenClaims(payload: unknown): AccessTokenClaims | null {
  if (!payload || typeof payload !== 'object') return null
  const claims = payload as Record<string, unknown>
  if (
    typeof claims['sub'] !== 'string' ||
    typeof claims['orgId'] !== 'string' ||
    typeof claims['jti'] !== 'string' ||
    typeof claims['sessionVersion'] !== 'number'
  ) {
    return null
  }
  return {
    sub: claims['sub'],
    orgId: claims['orgId'],
    jti: claims['jti'],
    sessionVersion: claims['sessionVersion'],
    iat: typeof claims['iat'] === 'number' ? claims['iat'] : undefined,
    exp: typeof claims['exp'] === 'number' ? claims['exp'] : undefined,
  }
}

export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashRefreshToken(opaque: string): string {
  return createHmac('sha256', env.REFRESH_TOKEN_HMAC_SECRET).update(opaque).digest('hex')
}

export function generatePendingMfaToken(): string {
  return randomBytes(16).toString('base64url')
}

export function hashPendingMfaToken(opaque: string): string {
  return createHmac('sha256', env.MFA_PENDING_SESSION_HMAC_SECRET).update(opaque).digest('hex')
}

export function refreshTokensMatch(storedHash: string, opaque: string): boolean {
  const computed = hashRefreshToken(opaque)
  if (!/^[0-9a-f]{64}$/i.test(storedHash)) return false
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
  if (tokens.refreshOpaque) {
    reply.setCookie('refresh-token', tokens.refreshOpaque, {
      httpOnly: true,
      sameSite: 'strict',
      secure,
      path: '/',
      maxAge: tokens.refreshMaxAgeSec,
    })
  }
}

export function clearAuthCookies(reply: CookieReply): void {
  reply.clearCookie('access-token', { path: '/' })
  reply.clearCookie('refresh-token', { path: '/' })
}

/** Minimal shape `buildCookieTokens` needs from the fastify instance — just the jwt plugin's `sign`. */
export type JwtSigner = {
  jwt: {
    sign: (
      payload: Record<string, unknown>,
      options: { jti: string; expiresIn: number }
    ) => Promise<string> | string
  }
}

type BuildableTokens = {
  accessClaims: { sub: string; orgId: string; sessionVersion: number; jti: string }
  accessMaxAgeSec: number
}

/** Signs the access-token JWT for a set of session tokens, returning them with `accessJwt` attached. */
export async function buildCookieTokens<T extends BuildableTokens>(
  fastify: JwtSigner,
  tokens: T
): Promise<T & { accessJwt: string }> {
  const jwt = await fastify.jwt.sign(
    {
      sub: tokens.accessClaims.sub,
      orgId: tokens.accessClaims.orgId,
      sessionVersion: tokens.accessClaims.sessionVersion,
    },
    { jti: tokens.accessClaims.jti, expiresIn: tokens.accessMaxAgeSec }
  )
  return { ...tokens, accessJwt: jwt }
}
