import { and, eq, sql } from 'drizzle-orm'
import { getDb, type Tx } from '@project-vault/db'
import {
  auditLogEntries,
  pendingMfaSessions,
  users,
  userIdentityTokens,
} from '@project-vault/db/schema'
import { AuditEvent } from '@project-vault/shared'
import { AppError } from '../../lib/errors.js'
import { env } from '../../config/env.js'
import { getAuditKey } from '../vault/key-service.js'
import { currentAuditKeyVersion } from '../audit/key-version.js'
import { computeAuditHmac } from '../audit/write-entry.js'
import { recordFailedAuthAttempt } from './failed-auth.js'
import { verifyConfirmedLoginTotp } from './mfa.js'
import { createLoginSessionInTx, type LoginResult, type RequestMeta } from './service.js'
import { generatePendingMfaToken, hashPendingMfaToken } from './tokens.js'

export type MfaChallengeResult = { mfaRequired: true; mfaToken: string }
type VerifyLoginOutcome =
  | { kind: 'success'; session: LoginResult }
  | { kind: 'invalid_totp' }
  | { kind: 'mfa_token_expired' }

const MAX_TOKEN_COLLISION_RETRIES = 2
const TOTP_METHOD = 'totp'
const MFA_LOGIN_CHALLENGED_EVENT = 'auth.mfa_login_challenged'
const MFA_LOGIN_FAILED_EVENT = 'auth.mfa_login_failed'
const MFA_LOGIN_VERIFIED_EVENT = 'auth.mfa_login_verified'

function mfaTokenExpired(): AppError {
  return new AppError('mfa_token_expired', 'Your login session expired. Please sign in again.', 401)
}

function invalidTotp(): AppError {
  return new AppError('invalid_totp', 'The authenticator code is incorrect.', 422)
}

function isAttemptCapped(attemptCount: number): boolean {
  return attemptCount >= env.MFA_LOGIN_MAX_ATTEMPTS
}

async function dbNow(tx: Tx): Promise<Date> {
  const rows = await tx.execute(sql`SELECT NOW() AS now`)
  return new Date(String((rows[0] as { now: Date | string }).now))
}

async function attemptedEmailForUser(tx: Tx, userId: string): Promise<string> {
  const rows = await tx
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  return rows[0]?.email ?? 'unknown@example.invalid'
}

async function identityTokenForUser(tx: Tx, userId: string): Promise<string | null> {
  const rows = await tx
    .select({ id: userIdentityTokens.id })
    .from(userIdentityTokens)
    .where(eq(userIdentityTokens.userId, userId))
    .limit(1)
  return rows[0]?.id ?? null
}

async function writeAuditEntry(
  tx: Tx,
  fields: {
    orgId: string
    actorTokenId: string | null
    eventType: string
    payload: Record<string, unknown>
    meta?: RequestMeta
  }
): Promise<void> {
  await tx.execute(sql`SELECT set_config('app.current_org_id', ${fields.orgId}, true)`)
  const keyVersion = await currentAuditKeyVersion(tx)
  const hmac = computeAuditHmac(
    {
      orgId: fields.orgId,
      actorTokenId: fields.actorTokenId,
      actorType: 'human',
      eventType: fields.eventType,
      payload: fields.payload,
      keyVersion,
    },
    getAuditKey()
  )

  await tx.insert(auditLogEntries).values({
    orgId: fields.orgId,
    actorTokenId: fields.actorTokenId,
    actorType: 'human',
    eventType: fields.eventType,
    payload: fields.payload,
    keyVersion,
    hmac,
    ipAddress: fields.meta?.ipAddress ?? null,
    userAgent: fields.meta?.userAgent ?? null,
  })
}

async function tryWriteLoginFailedAudit(
  tx: Tx,
  row: { userId: string; orgId: string },
  meta: RequestMeta
): Promise<void> {
  try {
    await writeAuditEntry(tx, {
      orgId: row.orgId,
      actorTokenId: await identityTokenForUser(tx, row.userId),
      eventType: AuditEvent.LOGIN_FAILED,
      payload: { method: 'totp_login' },
      meta,
    })
  } catch (error) {
    process.stderr.write(
      `[auth.mfa_login_failed_audit_error] ${error instanceof Error ? error.message : String(error)}\n`
    )
  }
}

async function deletePendingSession(tx: Tx, tokenHash: string): Promise<void> {
  await tx.delete(pendingMfaSessions).where(eq(pendingMfaSessions.tokenHash, tokenHash))
}

async function insertPendingChallenge(
  tx: Tx,
  input: { userId: string; orgId: string },
  meta: RequestMeta
): Promise<MfaChallengeResult | null> {
  const mfaToken = generatePendingMfaToken()
  const tokenHash = hashPendingMfaToken(mfaToken)
  const inserted = await tx
    .insert(pendingMfaSessions)
    .values({
      userId: input.userId,
      orgId: input.orgId,
      tokenHash,
      attemptCount: 0,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent?.slice(0, 512) ?? null,
      expiresAt:
        sql`NOW() + (${env.MFA_PENDING_SESSION_TTL_SECONDS} || ' seconds')::interval` as unknown as Date,
    })
    .onConflictDoNothing({ target: pendingMfaSessions.tokenHash })
    .returning({ id: pendingMfaSessions.id })
  return inserted[0] ? { mfaRequired: true, mfaToken } : null
}

export async function createPendingMfaSession(
  input: { userId: string; orgId: string },
  meta: RequestMeta = {}
): Promise<MfaChallengeResult> {
  return getDb().transaction(async (tx) => {
    const db = tx as Tx
    await db.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.userId}:${input.orgId}`}, 0))`
    )
    await db
      .delete(pendingMfaSessions)
      .where(
        and(eq(pendingMfaSessions.userId, input.userId), eq(pendingMfaSessions.orgId, input.orgId))
      )

    for (let attempt = 0; attempt <= MAX_TOKEN_COLLISION_RETRIES; attempt += 1) {
      const challenge = await insertPendingChallenge(db, input, meta)
      if (challenge) {
        process.stdout.write(
          `${JSON.stringify({ eventType: MFA_LOGIN_CHALLENGED_EVENT, userId: input.userId, orgId: input.orgId, method: TOTP_METHOD })}\n`
        )
        return challenge
      }
    }
    throw new AppError('service_unavailable', 'MFA login challenge could not be created', 503)
  })
}

async function consumeInvalidAttempt(
  tx: Tx,
  row: {
    userId: string
    orgId: string
    tokenHash: string
    attemptCount: number
    ipAddress: string | null
  },
  meta: RequestMeta,
  replayed: boolean
): Promise<VerifyLoginOutcome> {
  const nextAttemptCount = row.attemptCount + 1
  if (nextAttemptCount >= env.MFA_LOGIN_MAX_ATTEMPTS) {
    await deletePendingSession(tx, row.tokenHash)
    process.stdout.write(
      `${JSON.stringify({ eventType: MFA_LOGIN_FAILED_EVENT, userId: row.userId, method: TOTP_METHOD, reason: 'attempt_capped' })}\n`
    )
    return { kind: 'mfa_token_expired' }
  }

  await tx
    .update(pendingMfaSessions)
    .set({ attemptCount: nextAttemptCount })
    .where(eq(pendingMfaSessions.tokenHash, row.tokenHash))
  await tryWriteLoginFailedAudit(tx, row, meta)

  if (!replayed) {
    void recordFailedAuthAttempt({
      userId: row.userId,
      ipAddress: meta.ipAddress ?? row.ipAddress ?? '0.0.0.0',
      attemptedEmail: await attemptedEmailForUser(tx, row.userId),
      reason: 'invalid_totp',
    })
  }
  process.stdout.write(
    `${JSON.stringify({ eventType: MFA_LOGIN_FAILED_EVENT, userId: row.userId, method: TOTP_METHOD, reason: replayed ? 'replayed_totp' : 'invalid_totp' })}\n`
  )
  return { kind: 'invalid_totp' }
}

export async function verifyLogin(
  input: { mfaToken: string; totp: string },
  meta: RequestMeta = {}
): Promise<LoginResult> {
  const tokenHash = hashPendingMfaToken(input.mfaToken)
  const outcome = await getDb().transaction(async (tx): Promise<VerifyLoginOutcome> => {
    const db = tx as Tx
    const rows = await db
      .select()
      .from(pendingMfaSessions)
      .where(eq(pendingMfaSessions.tokenHash, tokenHash))
      .for('update')
      .limit(1)
    const row = rows[0]
    if (!row) return { kind: 'mfa_token_expired' }

    const now = await dbNow(db)
    if (row.expiresAt.getTime() <= now.getTime() || isAttemptCapped(row.attemptCount)) {
      await deletePendingSession(db, tokenHash)
      process.stdout.write(
        `${JSON.stringify({ eventType: MFA_LOGIN_FAILED_EVENT, userId: row.userId, orgId: row.orgId, method: TOTP_METHOD, reason: isAttemptCapped(row.attemptCount) ? 'attempt_capped' : 'expired_token' })}\n`
      )
      return { kind: 'mfa_token_expired' }
    }

    const totpResult = await verifyConfirmedLoginTotp(db, row.userId, input.totp)
    if (totpResult === 'no_enrollment') {
      await deletePendingSession(db, tokenHash)
      process.stdout.write(
        `${JSON.stringify({ eventType: MFA_LOGIN_FAILED_EVENT, userId: row.userId, orgId: row.orgId, method: TOTP_METHOD, reason: 'missing_enrollment' })}\n`
      )
      return { kind: 'mfa_token_expired' }
    }
    if (totpResult !== 'valid') {
      return consumeInvalidAttempt(db, row, meta, totpResult === 'replayed_code')
    }

    await db.execute(sql`SELECT set_config('app.current_org_id', ${row.orgId}, true)`)
    const identityTokenId = await identityTokenForUser(db, row.userId)
    const session = await createLoginSessionInTx(
      db,
      { id: row.userId, identityTokenId },
      row.orgId,
      meta
    )
    await writeAuditEntry(db, {
      orgId: row.orgId,
      actorTokenId: identityTokenId,
      eventType: AuditEvent.MFA_LOGIN_VERIFIED,
      payload: { method: TOTP_METHOD },
      meta,
    })
    await deletePendingSession(db, tokenHash)
    process.stdout.write(
      `${JSON.stringify({ eventType: MFA_LOGIN_VERIFIED_EVENT, userId: row.userId, orgId: row.orgId, method: TOTP_METHOD })}\n`
    )
    return { kind: 'success', session }
  })
  if (outcome.kind === 'success') return outcome.session
  if (outcome.kind === 'invalid_totp') throw invalidTotp()
  throw mfaTokenExpired()
}
