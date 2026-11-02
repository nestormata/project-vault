import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { getDb, type Tx } from '@project-vault/db'
import { cliOrgCredentials, userRefreshTokens, userSessions, users } from '@project-vault/db/schema'
import { env } from '../../config/env.js'
import { AppError } from '../../lib/errors.js'
import { revokeSessionById } from './session-revoke.js'
import { generateRefreshToken, hashRefreshToken, parseUserAccessClaims } from './tokens.js'
import type { RequestMeta } from './service.js'

const USER_REFRESH_REUSE_GRACE_MS = 30_000

export type UserAccessClaims = NonNullable<ReturnType<typeof parseUserAccessClaims>>

export type IssuedUserSession = {
  userId: string
  sessionId: string
  isPlatformOperator: boolean
  accessClaims: UserAccessClaims
  accessMaxAgeSec: number
  refreshOpaque: string
}

export type VerifiedUserSession = {
  userId: string
  sessionId: string
  jti: string
  isPlatformOperator: boolean
}

type RefreshRow = {
  id: string
  userSessionId: string
  expiresAt: Date
  usedAt: Date | null
  revokedAt: Date | null
  sessionRevokedAt: Date | null
  sessionExpiresAt: Date
  lastActiveAt: Date
  userId: string
  jti: string
  sessionVersion: number
}

export { parseUserAccessClaims }

function refreshLifetimeMs(): number {
  return env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000
}

function idleExceeded(lastActiveAt: Date, now: Date): boolean {
  return now.getTime() - lastActiveAt.getTime() > env.SESSION_IDLE_TIMEOUT_MINUTES * 60 * 1000
}

async function platformOperator(tx: Tx, userId: string): Promise<boolean> {
  const rows = await tx
    .select({ isPlatformOperator: users.isPlatformOperator })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  return rows[0]?.isPlatformOperator === true
}

export async function issueUserSessionInTx(
  tx: Tx,
  userId: string,
  meta: RequestMeta,
  now = new Date()
): Promise<IssuedUserSession> {
  const jti = randomUUID()
  const sessionExpiresAt = new Date(now.getTime() + refreshLifetimeMs())
  const inserted = await tx
    .insert(userSessions)
    .values({
      userId,
      jti,
      sessionVersion: 1,
      expiresAt: sessionExpiresAt,
      lastActiveAt: now,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    })
    .returning({ id: userSessions.id })
  const session = inserted[0]
  if (!session) throw new Error('user session insert returned no row')
  const refreshOpaque = generateRefreshToken()
  await tx.insert(userRefreshTokens).values({
    userSessionId: session.id,
    tokenHash: hashRefreshToken(refreshOpaque),
    expiresAt: sessionExpiresAt,
  })
  return {
    userId,
    sessionId: session.id,
    isPlatformOperator: await platformOperator(tx, userId),
    accessClaims: { sub: userId, scope: 'user', sessionVersion: 1, jti },
    accessMaxAgeSec: env.JWT_ACCESS_TTL_SECONDS,
    refreshOpaque,
  }
}

async function revokeLinkedCredentials(
  tx: Tx,
  links: { sessionId: string; orgId: string }[]
): Promise<void> {
  const [link, ...rest] = links
  if (!link) return
  await revokeSessionById(link.sessionId, {
    scope: 'logout',
    expectedOrgId: link.orgId,
    tx,
    audit: true,
  })
  await revokeLinkedCredentials(tx, rest)
}

async function revokeUserSessionInTx(tx: Tx, sessionId: string, now: Date): Promise<void> {
  await tx
    .update(userSessions)
    .set({ revokedAt: now, updatedAt: now })
    .where(eq(userSessions.id, sessionId))
  await tx
    .update(userRefreshTokens)
    .set({ revokedAt: now })
    .where(eq(userRefreshTokens.userSessionId, sessionId))
  const links = await tx
    .select({ sessionId: cliOrgCredentials.sessionId, orgId: cliOrgCredentials.orgId })
    .from(cliOrgCredentials)
    .where(eq(cliOrgCredentials.userSessionId, sessionId))
  await revokeLinkedCredentials(tx, links)
}

export async function revokeUserSessionById(sessionId: string, userId: string): Promise<boolean> {
  return getDb().transaction(async (dbTx) => {
    const tx = dbTx as Tx
    const rows = await tx
      .select({ id: userSessions.id, revokedAt: userSessions.revokedAt })
      .from(userSessions)
      .where(eq(userSessions.id, sessionId))
      .limit(1)
    const row = rows[0]
    if (!row) return false
    const owner = await tx
      .select({ userId: userSessions.userId })
      .from(userSessions)
      .where(eq(userSessions.id, sessionId))
      .limit(1)
    if (owner[0]?.userId !== userId) return false
    if (row.revokedAt) return true
    await revokeUserSessionInTx(tx, sessionId, new Date())
    return true
  })
}

export async function recordOrgCredential(
  tx: Tx,
  userSessionId: string,
  orgId: string,
  sessionId: string
): Promise<void> {
  await tx.insert(cliOrgCredentials).values({ userSessionId, orgId, sessionId })
}

function invalidRefresh(): AppError {
  return new AppError('refresh_token_invalid', 'Refresh token is invalid', 401)
}

function revokedRefresh(): AppError {
  return new AppError('refresh_token_revoked', 'Refresh token has been revoked', 401)
}

async function loadRefreshRow(tx: Tx, tokenHash: string): Promise<RefreshRow | undefined> {
  const tokenRows = await tx
    .select({
      id: userRefreshTokens.id,
      userSessionId: userRefreshTokens.userSessionId,
      expiresAt: userRefreshTokens.expiresAt,
      usedAt: userRefreshTokens.usedAt,
      revokedAt: userRefreshTokens.revokedAt,
    })
    .from(userRefreshTokens)
    .where(eq(userRefreshTokens.tokenHash, tokenHash))
    .for('update')
    .limit(1)
  const token = tokenRows[0]
  if (!token) return undefined
  const sessionRows = await tx
    .select({
      userId: userSessions.userId,
      jti: userSessions.jti,
      sessionVersion: userSessions.sessionVersion,
      revokedAt: userSessions.revokedAt,
      expiresAt: userSessions.expiresAt,
      lastActiveAt: userSessions.lastActiveAt,
    })
    .from(userSessions)
    .where(eq(userSessions.id, token.userSessionId))
    .limit(1)
  const session = sessionRows[0]
  if (!session) return undefined
  return {
    ...token,
    sessionRevokedAt: session.revokedAt,
    sessionExpiresAt: session.expiresAt,
    lastActiveAt: session.lastActiveAt,
    userId: session.userId,
    jti: session.jti,
    sessionVersion: session.sessionVersion,
  }
}

function rejectReusedRefresh(row: RefreshRow, now: Date): AppError {
  if (!row.usedAt) return invalidRefresh()
  return now.getTime() - row.usedAt.getTime() > USER_REFRESH_REUSE_GRACE_MS
    ? revokedRefresh()
    : invalidRefresh()
}

async function rotateUserRefresh(
  tx: Tx,
  row: RefreshRow,
  meta: RequestMeta,
  now: Date
): Promise<IssuedUserSession> {
  if (row.revokedAt || row.sessionRevokedAt) throw revokedRefresh()
  if (row.usedAt) {
    const error = rejectReusedRefresh(row, now)
    if (error.code === 'refresh_token_revoked') {
      await revokeUserSessionInTx(tx, row.userSessionId, now)
    }
    throw error
  }
  if (row.expiresAt.getTime() <= now.getTime() || row.sessionExpiresAt.getTime() <= now.getTime()) {
    throw new AppError('refresh_token_expired', 'Refresh token has expired', 401)
  }
  if (idleExceeded(row.lastActiveAt, now)) {
    await revokeUserSessionInTx(tx, row.userSessionId, now)
    throw new AppError('session_expired', 'Session expired due to inactivity', 401)
  }
  await tx.update(userRefreshTokens).set({ usedAt: now }).where(eq(userRefreshTokens.id, row.id))
  const refreshToken = generateRefreshToken()
  await tx.insert(userRefreshTokens).values({
    userSessionId: row.userSessionId,
    tokenHash: hashRefreshToken(refreshToken),
    expiresAt: row.sessionExpiresAt,
  })
  await tx
    .update(userSessions)
    .set({
      lastActiveAt: now,
      updatedAt: now,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    })
    .where(eq(userSessions.id, row.userSessionId))
  return {
    userId: row.userId,
    sessionId: row.userSessionId,
    isPlatformOperator: await platformOperator(tx, row.userId),
    accessClaims: {
      sub: row.userId,
      scope: 'user',
      sessionVersion: row.sessionVersion,
      jti: row.jti,
    },
    accessMaxAgeSec: env.JWT_ACCESS_TTL_SECONDS,
    refreshOpaque: refreshToken,
  }
}

export async function refreshUserSession(
  refreshOpaque: string,
  meta: RequestMeta,
  now = new Date()
): Promise<IssuedUserSession> {
  const tokenHash = hashRefreshToken(refreshOpaque)
  return getDb().transaction(async (dbTx) => {
    const tx = dbTx as Tx
    const row = await loadRefreshRow(tx, tokenHash)
    if (!row) throw invalidRefresh()
    return rotateUserRefresh(tx, row, meta, now)
  })
}

export async function revokeUserSessionByRefresh(refreshOpaque: string): Promise<boolean> {
  const tokenHash = hashRefreshToken(refreshOpaque)
  return getDb().transaction(async (dbTx) => {
    const tx = dbTx as Tx
    const row = await loadRefreshRow(tx, tokenHash)
    if (!row || row.sessionRevokedAt) return false
    await revokeUserSessionInTx(tx, row.userSessionId, new Date())
    return true
  })
}

export async function verifyUserSession(
  claims: UserAccessClaims,
  now = new Date()
): Promise<VerifiedUserSession> {
  return getDb().transaction(async (dbTx) => {
    const tx = dbTx as Tx
    const rows = await tx
      .select({
        id: userSessions.id,
        userId: userSessions.userId,
        jti: userSessions.jti,
        sessionVersion: userSessions.sessionVersion,
        revokedAt: userSessions.revokedAt,
        expiresAt: userSessions.expiresAt,
        lastActiveAt: userSessions.lastActiveAt,
      })
      .from(userSessions)
      .where(eq(userSessions.jti, claims.jti))
      .limit(1)
    const row = rows[0]
    if (
      !row ||
      row.revokedAt ||
      row.userId !== claims.sub ||
      row.sessionVersion !== claims.sessionVersion ||
      row.expiresAt.getTime() <= now.getTime()
    ) {
      throw new AppError('session_revoked', 'Session has been revoked', 401)
    }
    if (idleExceeded(row.lastActiveAt, now)) {
      await revokeUserSessionInTx(tx, row.id, now)
      throw new AppError('session_expired', 'Session expired due to inactivity', 401)
    }
    await tx
      .update(userSessions)
      .set({ lastActiveAt: now, updatedAt: now })
      .where(eq(userSessions.id, row.id))
    return {
      userId: row.userId,
      sessionId: row.id,
      jti: row.jti,
      isPlatformOperator: await platformOperator(tx, row.userId),
    }
  })
}
