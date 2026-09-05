import { and, eq, inArray, isNull, ne, sql, type SQL } from 'drizzle-orm'
import { getDb, type Tx } from '@project-vault/db'
import {
  apiKeys,
  auditLogEntries,
  refreshTokens,
  revokedTokens,
  sessions,
} from '@project-vault/db/schema'
import { AuditEvent } from '@project-vault/shared'
import { env } from '../../config/env.js'
import { AppError } from '../../lib/errors.js'
import { firstActorTokenIdForUser } from '../audit/actor-token.js'
import { currentAuditKeyVersion } from '../audit/key-version.js'
import { computeAuditHmac, getPreviousEntryHmac, GENESIS_SENTINEL } from '../audit/write-entry.js'
import { assertOrgMayWriteAuditGates, estimateAuditEntrySizeBytes } from '../audit/quota-gate.js'
import { writeSystemAuditEntry } from '../audit/machine-entry.js'
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
  | 'account_recovery'
  // Story 8.4 D4: distinguishes erasure-triggered session revocation from an ordinary
  // admin-forced revoke or self-service deactivation in audit rows.
  | 'erasure'

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
  // Deliberately NOT using audit/write-entry.ts's readAuditChainHead() helper here: everywhere
  // else, currentAuditKeyVersion() and getPreviousEntryHmac() are called back-to-back with
  // nothing but pure/synchronous work between them, so consolidating the pair is a pure
  // dedupe with no behavior change. Here they are NOT adjacent — actorTokenId's DB lookup and
  // assertOrgMayWriteAuditGates() (which may throw, and which the advisory-lock-holding
  // previous-row read should not precede) sit between them. Combining the two calls would move
  // this keyVersion read to after the gate, which is an actual reordering, not just dedupe — out
  // of scope for the jscpd fix.
  const keyVersion = await currentAuditKeyVersion(tx)
  const payload = {
    sessionId: fields.sessionId,
    scope: fields.scope,
    actorUserId: fields.actorUserId,
    targetUserId: fields.targetUserId,
    bulk: fields.bulk,
    revokedCount: fields.revokedCount,
  }
  // Code-review finding (Story 8.1): this used to hardcode actorTokenId: null unconditionally,
  // which meant every real session revocation (logout, deactivation, admin_action, idle_expiry,
  // security, account_recovery) permanently violated checkAuditActorTokenCoverage
  // (packages/db/src/check-audit-actor-token-coverage.ts) for an actor who typically already has
  // a real user_identity_tokens row — audit_log_entries is append-only, so this was a live,
  // unbounded production gap, not a test-only issue. Resolve the acting user's real token the
  // same way every other human-actor audit write does (firstActorTokenIdForUser).
  const actorTokenId = await firstActorTokenIdForUser(tx, fields.actorUserId)
  // Story 22.1 AC-13 / 22.2 AC-4 (site 7 of 9). orgId is always fields.orgId (never
  // request-derived).
  await assertOrgMayWriteAuditGates(tx, {
    orgId: fields.orgId,
    eventType: AuditEvent.SESSION_REVOKED,
    sizeBytes: estimateAuditEntrySizeBytes({ payload }),
  })
  const previousHmac = await getPreviousEntryHmac(tx, {
    table: 'audit_log_entries',
    orgId: fields.orgId,
  })
  const hmac = computeAuditHmac(
    {
      orgId: fields.orgId,
      actorTokenId,
      actorType: 'human',
      eventType: AuditEvent.SESSION_REVOKED,
      payload,
      keyVersion,
      previousEntryHmac: previousHmac ?? GENESIS_SENTINEL,
    },
    getAuditKey()
  )

  await tx.insert(auditLogEntries).values({
    orgId: fields.orgId,
    actorTokenId,
    actorType: 'human',
    eventType: AuditEvent.SESSION_REVOKED,
    payload,
    keyVersion,
    hmac,
    previousEntryHmac: previousHmac,
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
  reason: 'admin_action' | 'deactivation' | 'security' | 'account_recovery' | 'erasure'
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

export type RevokeAllSessionsForOrgResult = {
  sessionsRevokedCount: number
  apiKeysRevokedCount: number
}

/**
 * Story 31.1 (DW-130) Decision 4/Decision 6 — the org-wide fan-out for the
 * machine-authenticated CentralizeMe revocation route. Deliberately NOT a wrapper around
 * `revokeSessionById()`/`revokeTargetSessions()` (see Decision 2's original, since-amended
 * framing): a per-session application loop means N round-trips for a large org, each paying full
 * transaction-lock-duration latency. Instead this runs three bulk SQL statements — sessions,
 * refresh tokens, revoked-token inserts — plus a fourth bulk `api_keys` update (Decision 6), all
 * inside exactly ONE `getDb().transaction()`, with a Postgres advisory transaction lock
 * (AC11.37) as the very first statement and the audit write (AC7.24) as the last, before commit.
 * A single COMMIT for the whole call (AC11.35) — any failure anywhere (including the audit-quota
 * gate, AC7.27) rolls back everything (AC11.36): no partially-revoked org state is possible.
 */
export async function revokeAllSessionsForOrg({
  orgId,
  requestId,
  tx,
}: {
  orgId: string
  requestId: string
  tx?: Tx
}): Promise<RevokeAllSessionsForOrgResult> {
  return runInTx(tx, async (innerTx) => {
    // AC11.37: the advisory lock is the transaction's FIRST statement — acquired before the
    // org-scoped RLS context below, since pg_advisory_xact_lock is a session-level Postgres
    // builtin that never touches an RLS-protected table and needs no org context to run. This
    // creates real mutual exclusion with createLoginSessionInTx()'s matching
    // pg_advisory_xact_lock(hashtext(orgId)) acquisition (service.ts) — whichever transaction
    // (a login, or this revocation) acquires the lock first proceeds to completion and releases
    // it at commit; the other blocks until then. No session created concurrently with a call to
    // this route is ever missed (Decision 4).
    await innerTx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${orgId}))`)
    await applyExpectedOrgContext(innerTx, orgId)

    const now = new Date()

    // 1. Bulk-revoke sessions, RETURNING what was touched — already-revoked sessions are
    // excluded by the WHERE predicate up front (AC4.16), so they can never appear here or
    // generate a second revoked_tokens insert attempt. Filters on sessions.org_id directly —
    // never joins through org_memberships or checks membership status (AC4.17), so an orphaned
    // session for an already-deactivated/removed member is still caught.
    const revokedSessionRows = await innerTx
      .update(sessions)
      .set({
        revokedAt: now,
        sessionVersion: sql`${sessions.sessionVersion} + 1`,
        updatedAt: now,
      })
      .where(and(eq(sessions.orgId, orgId), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id, userId: sessions.userId, jti: sessions.jti })

    const sessionIds = revokedSessionRows.map((row) => row.id)

    if (sessionIds.length > 0) {
      // 2. Bulk-revoke their refresh tokens.
      await innerTx
        .update(refreshTokens)
        .set({ revokedAt: now })
        .where(and(inArray(refreshTokens.sessionId, sessionIds), isNull(refreshTokens.revokedAt)))

      // 3. Bulk-insert revoked_tokens rows, one per revoked session's jti. There is no single
      // caller-supplied accessTokenExp for a bulk org-wide call (unlike the single-session path),
      // so this deliberately deviates from computeRevokedTokenExpiresAt()'s per-call
      // accessTokenExp precedent: every row uses the same fixed
      // now + JWT_ACCESS_TTL_SECONDS expiry, computed once via computeRevokedTokenExpiresAt with
      // no accessTokenExp/refreshTokenExpiresAt override. This is an accepted simplification
      // (Decision 4) — documented here, not silently assumed.
      const revokedTokenExpiresAt = computeRevokedTokenExpiresAt({ now })
      await innerTx
        .insert(revokedTokens)
        .values(
          revokedSessionRows.map((row) => ({
            jti: row.jti,
            userId: row.userId,
            expiresAt: revokedTokenExpiresAt,
          }))
        )
        .onConflictDoNothing()

      // In-process cache eviction, not a DB statement — a cheap in-memory loop over the
      // RETURNING id list, not a per-session round-trip.
      for (const row of revokedSessionRows) evictSessionActivityDebounce(row.id)

      // deletePendingEnrollmentForUser operates per-user, not per-session — called once per
      // distinct user_id from the returned rows (its own idempotency makes calling it twice for
      // the same user across two sessions a safe no-op).
      const distinctUserIds = [...new Set(revokedSessionRows.map((row) => row.userId))]
      for (const userId of distinctUserIds) {
        await deletePendingEnrollmentForUser(userId, innerTx)
      }
    }

    // Decision 6/AC12: bulk-revoke every active machine-user API key for the org, in the SAME
    // transaction. api_keys already carries org_id directly (orgScoped()) — no join through
    // machine_users/projects needed. Only api_keys.revoked_at is set (AC12.43) —
    // machine_users.deactivated_at is left untouched, and no rows are deleted, consistent with
    // the session-revocation precedent.
    const revokedApiKeyRows = await innerTx
      .update(apiKeys)
      .set({ revokedAt: now })
      .where(and(eq(apiKeys.orgId, orgId), isNull(apiKeys.revokedAt)))
      .returning({ id: apiKeys.id })

    const sessionsRevokedCount = sessionIds.length
    const apiKeysRevokedCount = revokedApiKeyRows.length

    // AC7.24/AC7.25: exactly one audit row per call, written with the SAME innerTx, BEFORE
    // commit — always, even at zero counts (unlike revokeAllOtherSessions's
    // `if (result.revokedCount > 0)` convention above). An external service invoking an
    // org-deprovisioning-adjacent action is itself forensically significant regardless of
    // outcome. actorType is 'system' (writeSystemAuditEntry), never 'human'/'machine_user' — this
    // caller has no resolvable human actor token or PV machine-user key. Because
    // assertOrgMayWriteAuditGates (inside writeSystemAuditEntry) runs inside this same
    // transaction, an exhausted audit quota throws here and rolls back the whole transaction —
    // no sessions, no API keys, nothing revoked (AC7.27) — this route does not get an
    // audit-quota bypass.
    await writeSystemAuditEntry(innerTx, {
      orgId,
      eventType: AuditEvent.ORG_SESSIONS_REVOKED_BY_SERVICE,
      payload: {
        sessionsRevokedCount,
        apiKeysRevokedCount,
        requestId,
        triggeredBy: 'centralizeme',
      },
    })

    return { sessionsRevokedCount, apiKeysRevokedCount }
  })
}

export function sessionNotFound(): AppError {
  return new AppError('session_not_found', 'Session not found', 404)
}
