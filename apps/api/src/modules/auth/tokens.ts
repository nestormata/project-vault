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

/**
 * Story 25.6 AC1/AC5 — the double-submit-cookie CSRF token (Task 1 decision, see this story's
 * Dev Notes/Elicitation Log): a plain opaque random value, mirroring `generateRefreshToken()`'s
 * own generation shape. No server-side storage/lookup is needed — verification is a stateless
 * cookie-vs-header equality check (`apps/api/src/lib/csrf.ts`'s `isRejectedByCsrfToken()`), which
 * is also what makes two concurrent legitimate requests from the same session both succeed
 * (Dev Notes "Testing requirements" — a naive single-use-token design would break this).
 */
export function generateCsrfToken(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * Story 25.6 AC7 — the `__Host-` prefix is the strongest available host-only/Secure/Path=/
 * scoping a cookie can carry (prevents a compromised sibling subdomain from "cookie-tossing" a
 * forged value onto this cookie — see this story's Red Team elicitation round), but browsers
 * silently refuse to ever SET a `__Host-`-prefixed cookie unless the `Secure` attribute is also
 * present. `env.COOKIE_SECURE` is false in local/dev (plain HTTP, matching every other cookie in
 * this module's own `secure` gate) — using the prefix unconditionally there would silently break
 * every dev/test login. The bare name still carries this same function's caller's `Path: '/'` and
 * no `Domain` attribute (AC7's stated equivalent fallback), so host-only scoping still applies
 * either way; only the browser-enforced `__Host-` guarantee is deferred until COOKIE_SECURE (and
 * therefore HTTPS) is actually on, i.e. production.
 */
export function csrfCookieName(secure: boolean): string {
  return secure ? '__Host-csrf-token' : 'csrf-token'
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
  // Story 25.6 AC1/AC5/Task 1 — issued at the SAME point as the session cookie itself (Dev Notes
  // "Token issuance timing": avoids a GET-then-POST bootstrap gap, since the CSRF cookie is now
  // always present alongside a fresh/rotated session and rotates with it). Deliberately NOT
  // httpOnly, unlike the two cookies above — apps/web's postMessage-relay fetch
  // (extensions/panels/[slot]/+page.svelte) must read this value back via `document.cookie` to
  // echo it as a request header.
  reply.setCookie(csrfCookieName(secure), generateCsrfToken(), {
    httpOnly: false,
    sameSite: 'strict',
    secure,
    path: '/',
    maxAge: tokens.accessMaxAgeSec,
  })
}

export function clearAuthCookies(reply: CookieReply): void {
  reply.clearCookie('access-token', { path: '/' })
  reply.clearCookie('refresh-token', { path: '/' })
  // Story 25.6 AC1 — cleared alongside the session cookies so a CSRF token never outlives the
  // session it was issued for (Dev Notes "Testing requirements": must be invalidated/rotated
  // consistently with the session's own lifecycle).
  // Code review fix: the clearing Set-Cookie MUST also carry `secure: true` whenever the cookie
  // itself was set with the `__Host-` prefix (i.e. env.COOKIE_SECURE) — a `__Host-`-prefixed
  // Set-Cookie header without the `Secure` attribute is invalid per the `__Host-` prefix rules and
  // compliant browsers silently ignore it entirely, so omitting `secure` here would mean logout
  // never actually clears the CSRF cookie in production.
  reply.clearCookie(csrfCookieName(env.COOKIE_SECURE), {
    path: '/',
    secure: env.COOKIE_SECURE,
  })
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
