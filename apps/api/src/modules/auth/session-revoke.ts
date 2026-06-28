import { and, eq, isNull, ne, sql, type SQL } from 'drizzle-orm'
import { getDb, type Tx } from '@project-vault/db'
import { auditLogEntries, refreshTokens, revokedTokens, sessions } from '@project-vault/db/schema'
import { AuditEvent } from '@project-vault/shared'
import { env } from '../../config/env.js'
import { AppError } from '../../lib/errors.js'
import { currentAuditKeyVersion } from '../audit/key-version.js'
import { computeAuditHmac } from '../audit/write-entry.js'
import { getAuditKey } from '../vault/key-service.js'
import { deletePendingEnrollmentForUser } from './recovery-codes.js'
import { evictSessionActivityDebounce } from './session-activity.js'

export type SessionRevokeScope =
  | 'single'
  | 'all_except_current'
  | 'admin_action'
  | 'logout'
  | 'idle_expiry'
  | 'deactivation'
  | 'security'

type RevokeSessionOptions = {
  actorUserId?: string
  scope: SessionRevokeScope
  accessTokenExp?: Date
  tx?: Tx
  expectedUserId?: string
  expectedOrgId?: string
  audit?: boolean
}

type RevokeSessionResult = {
  revoked: boolean
  session?: {
    id: string
    userId: string
    orgId: string
    jti: string
  }
}

async function writeSessionRevokedAudit(
  tx: Tx,
  fields: {
    orgId: string
    sessionId?: string
    actorUserId: string
    targetUserId: string
    scope: SessionRevokeScope
    bulk?: boolean
    revokedCount?: number
  }
): Promise<void> {
  await tx.execute(sql`SELECT set_config('app.current_org_id', ${fields.orgId}, true)`)
  const keyVersion = await currentAuditKeyVersion(tx)
  const payload = {
    sessionId: fields.sessionId,
    scope: fields.scope,
    actorUserId: fields.actorUserId,
    targetUserId: fields.targetUserId,
    bulk: fields.bulk,
    revokedCount: fields.revokedCount,
  }
  const hmac = computeAuditHmac(
    {
      orgId: fields.orgId,
      actorTokenId: null,
      actorType: 'human',
      eventType: AuditEvent.SESSION_REVOKED,
      payload,
      keyVersion,
    },
    getAuditKey()
  )

  await tx.insert(auditLogEntries).values({
    orgId: fields.orgId,
    actorTokenId: null,
    actorType: 'human',
    eventType: AuditEvent.SESSION_REVOKED,
    payload,
    keyVersion,
    hmac,
  })
}

export function computeRevokedTokenExpiresAt({
  accessTokenExp,
  refreshTokenExpiresAt,
  now = new Date(),
}: {
  accessTokenExp?: Date
  refreshTokenExpiresAt?: Date | null
  now?: Date
}): Date {
  if (accessTokenExp) return accessTokenExp

  const accessTtlExpiresAt = new Date(now.getTime() + env.JWT_ACCESS_TTL_SECONDS * 1000)
  if (!refreshTokenExpiresAt) return accessTtlExpiresAt
  return refreshTokenExpiresAt.getTime() < accessTtlExpiresAt.getTime()
    ? refreshTokenExpiresAt
    : accessTtlExpiresAt
}

async function runInTx<T>(tx: Tx | undefined, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (tx) return fn(tx)
  return getDb().transaction((innerTx) => fn(innerTx as Tx))
}

async function selectRevocableSessionRows(tx: Tx, predicate: SQL | undefined) {
  return tx.select({ id: sessions.id, orgId: sessions.orgId }).from(sessions).where(predicate)
}

async function revokeTargetSessions(
  tx: Tx,
  targetSessions: Array<{ id: string; orgId: string }>,
  optionsForTarget: (sessionId: string) => RevokeSessionOptions
): Promise<{ revokedCount: number }> {
  let revokedCount = 0
  for (const target of targetSessions) {
    const result = await revokeSessionById(target.id, optionsForTarget(target.id))
    if (result.revoked) revokedCount += 1
  }
  return { revokedCount }
}

async function applyExpectedOrgContext(tx: Tx, expectedOrgId?: string): Promise<void> {
  if (!expectedOrgId) return
  await tx.execute(sql`SELECT set_config('app.current_org_id', ${expectedOrgId}, true)`)
}

async function selectRevocableUserSessionsInOrg(
  tx: Tx,
  {
    userId,
    orgId,
    extraPredicate,
  }: {
    userId: string
    orgId: string
    extraPredicate?: SQL
  }
) {
  await applyExpectedOrgContext(tx, orgId)
  const predicates = [
    eq(sessions.userId, userId),
    eq(sessions.orgId, orgId),
    isNull(sessions.revokedAt),
  ]
  if (extraPredicate) predicates.push(extraPredicate)
  return selectRevocableSessionRows(tx, and(...predicates))
}

function sessionDoesNotMatchOptions(
  session: { userId: string; orgId: string },
  options: RevokeSessionOptions
): boolean {
  return Boolean(
    (options.expectedUserId && session.userId !== options.expectedUserId) ||
    (options.expectedOrgId && session.orgId !== options.expectedOrgId)
  )
}

async function maybeWriteSessionRevokedAudit(
  tx: Tx,
  session: { id: string; userId: string; orgId: string },
  options: RevokeSessionOptions
): Promise<void> {
  if (options.audit === false) return
  await writeSessionRevokedAudit(tx, {
    orgId: session.orgId,
    sessionId: session.id,
    actorUserId: options.actorUserId ?? session.userId,
    targetUserId: session.userId,
    scope: options.scope,
  })
}

export async function revokeSessionById(
  sessionId: string,
  options: RevokeSessionOptions
): Promise<RevokeSessionResult> {
  return runInTx(options.tx, async (tx) => {
    await applyExpectedOrgContext(tx, options.expectedOrgId)
    const activeRefreshRows = await tx
      .select({ expiresAt: refreshTokens.expiresAt })
      .from(refreshTokens)
      .where(and(eq(refreshTokens.sessionId, sessionId), isNull(refreshTokens.revokedAt)))
      .for('update')
    const rows = await tx
      .select({
        id: sessions.id,
        userId: sessions.userId,
        orgId: sessions.orgId,
        jti: sessions.jti,
        sessionVersion: sessions.sessionVersion,
        revokedAt: sessions.revokedAt,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .for('update')
      .limit(1)
    const session = rows[0]
    if (!session || session.revokedAt) return { revoked: false }
    if (sessionDoesNotMatchOptions(session, options)) return { revoked: false }

    const activeRefresh = activeRefreshRows[0]
    const revokedAt = new Date()

    await tx
      .update(sessions)
      .set({
        revokedAt,
        sessionVersion: session.sessionVersion + 1,
        updatedAt: revokedAt,
      })
      .where(eq(sessions.id, sessionId))

    await tx
      .update(refreshTokens)
      .set({ revokedAt })
      .where(and(eq(refreshTokens.sessionId, sessionId), isNull(refreshTokens.revokedAt)))

    await tx
      .insert(revokedTokens)
      .values({
        jti: session.jti,
        userId: session.userId,
        expiresAt: computeRevokedTokenExpiresAt({
          accessTokenExp: options.accessTokenExp,
          refreshTokenExpiresAt: activeRefresh?.expiresAt,
          now: revokedAt,
        }),
      })
      .onConflictDoNothing()

    await deletePendingEnrollmentForUser(session.userId, tx)
    evictSessionActivityDebounce(session.id)

    await maybeWriteSessionRevokedAudit(tx, session, options)

    return {
      revoked: true,
      session: {
        id: session.id,
        userId: session.userId,
        orgId: session.orgId,
        jti: session.jti,
      },
    }
  })
}

export async function cleanupExpiredSession(
  sessionId: string,
  options: { tx?: Tx; orgId?: string } = {}
): Promise<void> {
  const result = await revokeSessionById(sessionId, {
    scope: 'idle_expiry',
    tx: options.tx,
    expectedOrgId: options.orgId,
  })
  if (!result.revoked) return
}

export async function revokeAllUserSessionsInOrg({
  userId,
  orgId,
  actorUserId,
  reason,
  tx,
}: {
  userId: string
  orgId: string
  actorUserId: string
  reason: 'admin_action' | 'deactivation' | 'security'
  tx?: Tx
}): Promise<{ revokedCount: number }> {
  return runInTx(tx, async (innerTx) => {
    const targetSessions = await selectRevocableUserSessionsInOrg(innerTx, { userId, orgId })

    return revokeTargetSessions(innerTx, targetSessions, () => ({
      actorUserId,
      scope: reason,
      tx: innerTx,
      expectedUserId: userId,
      expectedOrgId: orgId,
    }))
  })
}

export async function revokeAllOtherSessions({
  userId,
  orgId,
  currentJti,
  actorUserId,
  tx,
}: {
  userId: string
  orgId: string
  currentJti: string
  actorUserId: string
  tx?: Tx
}): Promise<{ revokedCount: number }> {
  return runInTx(tx, async (innerTx) => {
    const targetSessions = await selectRevocableUserSessionsInOrg(innerTx, {
      userId,
      orgId,
      extraPredicate: ne(sessions.jti, currentJti),
    })

    const result = await revokeTargetSessions(innerTx, targetSessions, () => ({
      actorUserId,
      scope: 'all_except_current',
      tx: innerTx,
      expectedUserId: userId,
      expectedOrgId: orgId,
      audit: false,
    }))
    if (result.revokedCount > 0) {
      await writeSessionRevokedAudit(innerTx, {
        orgId,
        actorUserId,
        targetUserId: userId,
        scope: 'all_except_current',
        bulk: true,
        revokedCount: result.revokedCount,
      })
    }
    return result
  })
}

export function sessionNotFound(): AppError {
  return new AppError('session_not_found', 'Session not found', 404)
}
