import { and, eq } from 'drizzle-orm'
import type { FastifyReply, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'
import { getDb, withOrg } from '@project-vault/db'
import { orgMemberships, revokedTokens, sessions, users } from '@project-vault/db/schema'
import { env } from '../config/env.js'
import { AppError } from '../lib/errors.js'
import { touchSessionActivity } from '../modules/auth/session-activity.js'
import { cleanupExpiredSession } from '../modules/auth/session-revoke.js'
import { parseAccessTokenClaims } from '../modules/auth/tokens.js'

const ORG_ROLES = new Set(['owner', 'admin', 'member', 'viewer'])

type JwtVerifier = {
  jwt: {
    verify: (token: string) => Promise<unknown> | unknown
  }
}
type ParsedAccessClaims = NonNullable<ReturnType<typeof parseAccessTokenClaims>>
type AuthSessionRow = {
  id: string
  userId: string
  orgId: string
  jti: string
  sessionVersion: number
  revokedAt: Date | null
  lastActiveAt: Date
}

function sendAuthError(reply: FastifyReply, error: AppError) {
  return reply.status(error.statusCode).send({ code: error.code, message: error.message })
}

function accessTokenInvalid(): AppError {
  return new AppError('access_token_invalid', 'Access token is invalid', 401)
}

function isOrgRole(role: string): role is 'owner' | 'admin' | 'member' | 'viewer' {
  return ORG_ROLES.has(role)
}

function assertTemporalClaims(claims: { iat?: number; exp?: number }): void {
  const nowSeconds = Math.floor(Date.now() / 1000)
  if (typeof claims.exp === 'number' && claims.exp < nowSeconds) throw accessTokenInvalid()
  if (typeof claims.iat === 'number' && claims.iat > nowSeconds + env.JWT_MAX_CLOCK_SKEW_SECONDS) {
    throw accessTokenInvalid()
  }
}

async function verifyAccessClaims(
  fastify: JwtVerifier,
  token: string
): Promise<ParsedAccessClaims> {
  let verified: unknown
  try {
    verified = await fastify.jwt.verify(token)
  } catch {
    throw accessTokenInvalid()
  }

  const claims = parseAccessTokenClaims(verified)
  if (!claims) throw accessTokenInvalid()
  assertTemporalClaims(claims)
  return claims
}

async function rejectRevokedToken(jti: string): Promise<void> {
  const revoked = await getDb()
    .select({ jti: revokedTokens.jti })
    .from(revokedTokens)
    .where(eq(revokedTokens.jti, jti))
    .limit(1)
  if (revoked[0]) {
    throw new AppError('session_revoked', 'Session has been revoked', 401)
  }
}

function assertSessionMatchesClaims(
  session: AuthSessionRow | undefined,
  claims: ParsedAccessClaims
): asserts session is AuthSessionRow {
  if (
    !session ||
    session.revokedAt ||
    session.sessionVersion !== claims.sessionVersion ||
    session.userId !== claims.sub ||
    session.orgId !== claims.orgId
  ) {
    throw new AppError('session_revoked', 'Session has been revoked', 401)
  }
}

async function loadSessionForClaims(claims: ParsedAccessClaims): Promise<AuthSessionRow> {
  const sessionRows = await withOrg(claims.orgId, (tx) =>
    tx
      .select({
        id: sessions.id,
        userId: sessions.userId,
        orgId: sessions.orgId,
        jti: sessions.jti,
        sessionVersion: sessions.sessionVersion,
        revokedAt: sessions.revokedAt,
        lastActiveAt: sessions.lastActiveAt,
      })
      .from(sessions)
      .where(eq(sessions.jti, claims.jti))
      .limit(1)
  )
  const session = sessionRows[0]
  assertSessionMatchesClaims(session, claims)
  return session
}

async function enforceIdleTimeout(session: AuthSessionRow): Promise<void> {
  const idleMs = env.SESSION_IDLE_TIMEOUT_MINUTES * 60 * 1000
  if (Date.now() - session.lastActiveAt.getTime() <= idleMs) return
  await cleanupExpiredSession(session.id, { orgId: session.orgId })
  throw new AppError('session_expired', 'Session expired due to inactivity', 401)
}

async function loadOrgRole(session: AuthSessionRow) {
  const memberships = await withOrg(session.orgId, (tx) =>
    tx
      .select({ role: orgMemberships.role })
      .from(orgMemberships)
      .where(
        and(
          eq(orgMemberships.userId, session.userId),
          eq(orgMemberships.orgId, session.orgId),
          eq(orgMemberships.status, 'active')
        )
      )
      .limit(1)
  )
  const membership = memberships[0]
  if (!membership || !isOrgRole(membership.role)) {
    throw new AppError('account_deactivated', 'Account is deactivated', 403)
  }
  return membership.role
}

// Story 9.1 D1: users has no org_id column and no RLS policy (identity-scoped, same trust model
// as other identity-scoped tables in check-rls-coverage.ts's EXCLUDED_TABLES) — a plain
// (non-org-scoped) getDb() read is correct here, same pattern as findLoginUser()'s organizations
// lookup in modules/auth/service.ts.
async function loadIsPlatformOperator(userId: string): Promise<boolean> {
  const rows = await getDb()
    .select({ isPlatformOperator: users.isPlatformOperator })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  return rows[0]?.isPlatformOperator ?? false
}

async function touchActivityWithoutBlocking(
  request: FastifyRequest,
  sessionId: string
): Promise<void> {
  try {
    await touchSessionActivity(sessionId)
  } catch (error) {
    request.log.warn({ eventType: 'session.activity_touch_failed', sessionId, err: error })
  }
}

export async function authenticateRequest(
  fastify: JwtVerifier,
  request: FastifyRequest,
  reply: FastifyReply
) {
  const token = request.cookies?.['access-token']
  if (!token) {
    return sendAuthError(
      reply,
      new AppError('access_token_missing', 'Access token is missing', 401)
    )
  }

  try {
    const claims = await verifyAccessClaims(fastify, token)
    await rejectRevokedToken(claims.jti)
    const session = await loadSessionForClaims(claims)
    await enforceIdleTimeout(session)
    const orgRole = await loadOrgRole(session)
    const isPlatformOperator = await loadIsPlatformOperator(session.userId)
    await touchActivityWithoutBlocking(request, session.id)

    request.authContext = {
      userId: session.userId,
      orgId: session.orgId,
      sessionId: session.id,
      jti: session.jti,
      sessionVersion: session.sessionVersion,
      orgRole,
      isPlatformOperator,
    }
  } catch (error) {
    if (error instanceof AppError) return sendAuthError(reply, error)
    request.log.error({ eventType: 'auth.infrastructure_error', err: error })
    return sendAuthError(
      reply,
      new AppError('service_unavailable', 'Authentication service is unavailable', 503)
    )
  }
}

export default fp(async (fastify) => {
  fastify.decorate('authenticate', (request: FastifyRequest, reply: FastifyReply) =>
    authenticateRequest(fastify as unknown as JwtVerifier, request, reply)
  )
})
