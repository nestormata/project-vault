import QRCode from 'qrcode'
import bcrypt from 'bcrypt'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { getDb, type Tx } from '@project-vault/db'
import {
  auditLogEntries,
  mfaEnrollments,
  mfaRecoveryCodes,
  orgMemberships,
  organizations,
  users,
  userIdentityTokens,
} from '@project-vault/db/schema'
import { AuditEvent } from '@project-vault/shared'
import type { EncryptedValue } from '@project-vault/crypto'
import { AppError } from '../../lib/errors.js'
import { env } from '../../config/env.js'
import { firstActorTokenIdForUser } from '../audit/actor-token.js'
import { currentAuditKeyVersion } from '../audit/key-version.js'
import { computeAuditHmac } from '../audit/write-entry.js'
import { getAuditKey } from '../vault/key-service.js'
import { recordFailedAuthAttempt } from './failed-auth.js'
import { verifyUserPassword } from './password.js'
import { normalizeEmail } from './normalize.js'
import { createLoginSessionInTx, type TokenMaterial } from './service.js'
import {
  countUnusedRecoveryCodes,
  deletePendingEnrollmentForUser,
  generateRecoveryCodes,
  hashRecoveryCode,
  isNormalizedRecoveryCode,
  normalizeRecoveryCode,
  recoveryCodeMatches,
} from './recovery-codes.js'
import {
  base32FromSecretBytes,
  buildOtpAuthUrl,
  decryptEnrollmentSecret,
  encryptTotpSecret,
  generateSecret,
  recordTotpUse,
  validateTotpCode,
} from './totp.js'

type RequestMeta = {
  ipAddress?: string | null
  userAgent?: string | null
}

type AuthContext = {
  userId: string
  orgId: string
}

type RecoveryResult = {
  userId: string
  orgId: string
  expiresAt: string
  remainingRecoveryCodes: number
  tokens: TokenMaterial
}

const DUMMY_RECOVERY_CODE_HASH =
  // eslint-disable-next-line no-secrets/no-secrets -- Test-only timing pad hash for a known dummy code.
  '$2b$10$N69wUwERzaedA4v2CD2yNuNTfjbwDj8g2x8Mk41u.lP6o11m8o6xW'

type AuditFields = {
  orgId: string
  actorTokenId: string | null
  eventType: string
  resourceId?: string
  resourceType?: string
  payload: Record<string, unknown>
  meta?: RequestMeta
}

function appError(code: string, message: string, statusCode: number): AppError {
  return new AppError(code, message, statusCode)
}

function invalidTotp(): AppError {
  return appError('invalid_totp', 'The authenticator code is incorrect.', 422)
}

function invalidRecoveryCredentials(): AppError {
  return appError('invalid_credentials', 'Invalid email, password, or recovery code.', 401)
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { cause?: { code?: string } }).cause?.code === '23505'
}

async function attemptedEmailForUser(userId: string, tx?: Tx): Promise<string> {
  const db = tx ?? getDb()
  const rows = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  return rows[0]?.email ?? 'unknown@example.invalid'
}

async function writeAuditEntry(tx: Tx, fields: AuditFields): Promise<void> {
  await tx.execute(sql`SELECT set_config('app.current_org_id', ${fields.orgId}, true)`)
  const keyVersion = await currentAuditKeyVersion(tx)
  const hmac = computeAuditHmac(
    {
      orgId: fields.orgId,
      actorTokenId: fields.actorTokenId,
      actorType: 'human',
      eventType: fields.eventType,
      resourceId: fields.resourceId,
      resourceType: fields.resourceType,
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
    resourceId: fields.resourceId,
    resourceType: fields.resourceType,
    payload: fields.payload,
    keyVersion,
    hmac,
    ipAddress: fields.meta?.ipAddress ?? null,
    userAgent: fields.meta?.userAgent ?? null,
  })
}

async function tryWriteFailedRecoverAudit(
  tx: Tx,
  user: { orgId: string | null; identityTokenId: string | null } | null,
  meta: RequestMeta
): Promise<void> {
  if (!user?.orgId) return
  try {
    await writeAuditEntry(tx, {
      orgId: user.orgId,
      actorTokenId: user.identityTokenId,
      eventType: AuditEvent.LOGIN_FAILED,
      payload: { method: 'recovery_code' },
      meta,
    })
  } catch (error) {
    process.stderr.write(
      `[auth.mfa_recover_failed_audit_error] ${error instanceof Error ? error.message : String(error)}\n`
    )
  }
}

async function hashRecoveryCodes(
  codes: string[]
): Promise<Array<{ userId: string; codeHash: string }>> {
  return Promise.all(
    codes.map(async (code) => ({
      userId: '',
      codeHash: await hashRecoveryCode(code, env.MFA_RECOVERY_CODE_BCRYPT_COST),
    }))
  )
}

async function recoveryCodeRows(userId: string, codes: string[]) {
  const hashed = await hashRecoveryCodes(codes)
  return hashed.map((row) => ({ ...row, userId }))
}

async function insertRecoveryCodes(tx: Tx, userId: string, codes: string[]): Promise<void> {
  await tx.insert(mfaRecoveryCodes).values(await recoveryCodeRows(userId, codes))
}

async function writeMfaEnrollmentAudit(
  tx: Tx,
  authContext: AuthContext,
  fields: {
    eventType: string
    enrollmentId: string
    payload: Record<string, unknown>
    meta: RequestMeta
  }
): Promise<void> {
  await writeAuditEntry(tx, {
    orgId: authContext.orgId,
    actorTokenId: await firstActorTokenIdForUser(tx, authContext.userId),
    eventType: fields.eventType,
    resourceId: fields.enrollmentId,
    resourceType: 'mfa_enrollment',
    payload: fields.payload,
    meta: fields.meta,
  })
}

async function buildQrCodeSvg(otpauthUrl: string): Promise<string> {
  return QRCode.toString(otpauthUrl, { type: 'svg', margin: 2, width: 256 })
}

export async function enrollMfa(authContext: AuthContext, meta: RequestMeta = {}, tx?: Tx) {
  const run = async (tx: unknown) => {
    const db = tx as Tx
    const userRows = await db
      .select({ id: users.id, email: users.email, mfaEnrolledAt: users.mfaEnrolledAt })
      .from(users)
      .where(eq(users.id, authContext.userId))
      .limit(1)
    const user = userRows[0]
    if (!user) throw appError('user_not_found', 'User not found', 404)
    if (user.mfaEnrolledAt) {
      throw appError(
        'mfa_already_enrolled',
        'MFA is already enabled. Disable MFA is not supported in v1.',
        409
      )
    }

    await deletePendingEnrollmentForUser(authContext.userId, db)
    const secret = generateSecret()
    const secretBuffer = Buffer.from(secret.buffer)
    const encrypted = await encryptTotpSecret(secretBuffer)
    secretBuffer.fill(0)

    const enrollmentRows = await db
      .insert(mfaEnrollments)
      .values({
        userId: authContext.userId,
        secretEncrypted: encrypted,
        status: 'pending',
        label: 'Authenticator',
      })
      .returning({ id: mfaEnrollments.id })
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) {
          throw appError('mfa_enrollment_conflict', 'MFA enrollment is already in progress.', 409)
        }
        throw error
      })
    const enrollment = enrollmentRows[0]
    if (!enrollment) throw new Error('enrollMfa: enrollment insert returned no row')

    await writeMfaEnrollmentAudit(db, authContext, {
      eventType: AuditEvent.MFA_ENROLLMENT_STARTED,
      enrollmentId: enrollment.id,
      payload: { method: 'totp' },
      meta,
    })

    const otpauthUrl = buildOtpAuthUrl(secret.base32, user.email)
    return {
      enrollmentId: enrollment.id,
      otpauthUrl,
      secret: secret.base32,
      qrCodeSvg: await buildQrCodeSvg(otpauthUrl),
    }
  }
  return tx ? run(tx) : getDb().transaction(run)
}

async function loadPendingEnrollmentForUpdate(tx: Tx, userId: string) {
  const rows = await tx
    .select({
      id: mfaEnrollments.id,
      status: mfaEnrollments.status,
      secretEncrypted: mfaEnrollments.secretEncrypted,
    })
    .from(mfaEnrollments)
    .where(eq(mfaEnrollments.userId, userId))
    .for('update')
    .limit(1)
  return rows[0]
}

async function loadConfirmedEnrollmentForUpdate(tx: Tx, userId: string) {
  const rows = await tx
    .select({
      id: mfaEnrollments.id,
      secretEncrypted: mfaEnrollments.secretEncrypted,
    })
    .from(mfaEnrollments)
    .where(and(eq(mfaEnrollments.userId, userId), eq(mfaEnrollments.status, 'confirmed')))
    .for('update')
    .limit(1)
  return rows[0]
}

async function validateEnrollmentTotp(
  tx: Tx,
  userId: string,
  enrollment: { id: string; secretEncrypted: EncryptedValue },
  totp: string,
  deletePendingOnInvalid: boolean
): Promise<'valid' | 'invalid_code' | 'replayed_code'> {
  const plaintext = await decryptEnrollmentSecret(enrollment.secretEncrypted)
  try {
    const normalizedTotp = totp.replace(/\s/g, '')
    const result = validateTotpCode(base32FromSecretBytes(plaintext), normalizedTotp)
    if (!result.valid || result.counter === undefined) {
      if (deletePendingOnInvalid) await deletePendingEnrollmentForUser(userId, tx)
      return 'invalid_code'
    }
    const recorded = await recordTotpUse(userId, result.counter, normalizedTotp, tx)
    return recorded ? 'valid' : 'replayed_code'
  } catch (error) {
    if (isUniqueViolation(error)) return 'invalid_code'
    throw error
  } finally {
    plaintext.fill(0)
  }
}

async function checkEnrollmentTotp(
  db: Tx,
  userId: string,
  enrollment: { id: string; secretEncrypted: EncryptedValue },
  totp: string,
  deletePendingOnInvalid: boolean
): Promise<{ invalidTotp: true; replayed: boolean } | null> {
  const totpResult = await validateEnrollmentTotp(
    db,
    userId,
    enrollment,
    totp,
    deletePendingOnInvalid
  )
  if (totpResult === 'valid') return null
  return { invalidTotp: true as const, replayed: totpResult === 'replayed_code' }
}

export async function verifyConfirmedLoginTotp(
  tx: Tx,
  userId: string,
  totp: string
): Promise<'valid' | 'invalid_code' | 'replayed_code' | 'no_enrollment'> {
  const enrollment = await loadConfirmedEnrollmentForUpdate(tx, userId)
  if (!enrollment) return 'no_enrollment'
  return validateEnrollmentTotp(tx, userId, enrollment, totp, false)
}

async function handleInvalidEnrollmentTotp(
  authContext: AuthContext,
  attemptedEmail: string,
  meta: RequestMeta,
  replayed: boolean
): Promise<never> {
  if (!replayed) {
    void recordFailedAuthAttempt({
      userId: authContext.userId,
      ipAddress: meta.ipAddress ?? '0.0.0.0',
      attemptedEmail,
      reason: 'invalid_totp',
    })
  }
  throw invalidTotp()
}

async function runEnrollmentTotpGuardedTransaction<T extends object>(
  authContext: AuthContext,
  meta: RequestMeta,
  fn: (db: Tx) => Promise<T | { invalidTotp: true; replayed: boolean }>,
  tx?: Tx
): Promise<T> {
  const attemptedEmail = await attemptedEmailForUser(authContext.userId, tx)
  const result = tx ? await fn(tx) : await getDb().transaction((innerTx) => fn(innerTx as Tx))
  if ('invalidTotp' in result) {
    await handleInvalidEnrollmentTotp(authContext, attemptedEmail, meta, result.replayed === true)
    throw invalidTotp()
  }
  return result
}

export async function verifyEnrollment(
  authContext: AuthContext,
  input: { totp: string },
  meta: RequestMeta = {},
  tx?: Tx
) {
  return runEnrollmentTotpGuardedTransaction(
    authContext,
    meta,
    async (db) => {
      const enrollment = await loadPendingEnrollmentForUpdate(db, authContext.userId)
      if (!enrollment) {
        throw appError('mfa_enrollment_not_started', 'MFA enrollment has not been started.', 409)
      }
      if (enrollment.status !== 'pending') throw invalidTotp()

      const totpCheck = await checkEnrollmentTotp(
        db,
        authContext.userId,
        enrollment,
        input.totp,
        true
      )
      if (totpCheck) return totpCheck

      const enrolledAt = new Date()
      const recoveryCodes = generateRecoveryCodes(env.MFA_RECOVERY_CODE_COUNT)
      await db
        .update(mfaEnrollments)
        .set({ status: 'confirmed', confirmedAt: enrolledAt })
        .where(eq(mfaEnrollments.id, enrollment.id))
      await db
        .update(users)
        .set({ mfaEnrolledAt: enrolledAt })
        .where(eq(users.id, authContext.userId))
      await insertRecoveryCodes(db, authContext.userId, recoveryCodes)
      await writeMfaEnrollmentAudit(db, authContext, {
        eventType: AuditEvent.MFA_ENROLLED,
        enrollmentId: enrollment.id,
        payload: { method: 'totp' },
        meta,
      })

      return { mfaEnrolledAt: enrolledAt.toISOString(), recoveryCodes }
    },
    tx
  )
}

export async function regenerateRecoveryCodes(
  authContext: AuthContext,
  input: { totp: string },
  meta: RequestMeta = {},
  tx?: Tx
) {
  return runEnrollmentTotpGuardedTransaction(
    authContext,
    meta,
    async (db) => {
      const enrollment = await loadConfirmedEnrollmentForUpdate(db, authContext.userId)
      if (!enrollment) throw appError('mfa_not_enrolled', 'MFA is not enrolled for this user.', 409)

      const totpCheck = await checkEnrollmentTotp(
        db,
        authContext.userId,
        enrollment,
        input.totp,
        false
      )
      if (totpCheck) return totpCheck

      const generatedAt = new Date()
      const recoveryCodes = generateRecoveryCodes(env.MFA_RECOVERY_CODE_COUNT)
      await db
        .update(mfaRecoveryCodes)
        .set({ usedAt: generatedAt })
        .where(
          and(eq(mfaRecoveryCodes.userId, authContext.userId), isNull(mfaRecoveryCodes.usedAt))
        )
      await insertRecoveryCodes(db, authContext.userId, recoveryCodes)
      await writeMfaEnrollmentAudit(db, authContext, {
        eventType: AuditEvent.MFA_RECOVERY_CODES_REGENERATED,
        enrollmentId: enrollment.id,
        payload: {
          method: 'totp',
          remainingRecoveryCodes: await countUnusedRecoveryCodes(authContext.userId, db),
        },
        meta,
      })

      process.stdout.write(
        `${JSON.stringify({ eventType: 'alert.pending_epic3', alertType: 'mfa.recovery_codes_regenerated', userId: authContext.userId })}\n`
      )

      return { recoveryCodes, generatedAt: generatedAt.toISOString() }
    },
    tx
  )
}

async function findRecoveryUser(email: string) {
  const userRows = await getDb()
    .select({
      id: users.id,
      email: users.email,
      passwordHash: users.passwordHash,
      mfaEnrolledAt: users.mfaEnrolledAt,
      identityTokenId: userIdentityTokens.id,
    })
    .from(users)
    .leftJoin(userIdentityTokens, eq(userIdentityTokens.userId, users.id))
    .where(eq(users.email, email))
    .limit(1)
  return userRows[0] ?? null
}

async function activeOrgForUser(tx: Tx, userId: string): Promise<string | null> {
  const orgRows = await tx.select({ orgId: organizations.id }).from(organizations)
  for (const { orgId } of orgRows) {
    await tx.execute(sql`SELECT set_config('app.current_org_id', ${orgId}, true)`)
    const memberships = await tx
      .select({ orgId: orgMemberships.orgId })
      .from(orgMemberships)
      .where(and(eq(orgMemberships.userId, userId), eq(orgMemberships.status, 'active')))
      .limit(1)
    if (memberships[0]) return orgId
  }
  return null
}

async function passwordMatches(password: string, hash: string | null): Promise<boolean> {
  try {
    return await verifyUserPassword(password, hash ?? env.AUTH_DUMMY_PASSWORD_HASH)
  } catch {
    return false
  }
}

async function findMatchingRecoveryCode(tx: Tx, userId: string, recoveryCode: string) {
  const rows = await tx
    .select({ id: mfaRecoveryCodes.id, codeHash: mfaRecoveryCodes.codeHash })
    .from(mfaRecoveryCodes)
    .where(and(eq(mfaRecoveryCodes.userId, userId), isNull(mfaRecoveryCodes.usedAt)))

  let matchedId: string | null = null
  for (const row of rows) {
    if (await recoveryCodeMatches(recoveryCode, row.codeHash)) {
      matchedId = row.id
    }
  }
  if (rows.length === 0) await bcrypt.compare(recoveryCode, DUMMY_RECOVERY_CODE_HASH)
  return matchedId
}

export async function recoverWithCode(
  input: { email: string; password: string; recoveryCode: string },
  meta: RequestMeta = {}
): Promise<RecoveryResult> {
  const email = normalizeEmail(input.email)
  const normalizedRecoveryCode = normalizeRecoveryCode(input.recoveryCode)
  if (!isNormalizedRecoveryCode(normalizedRecoveryCode)) {
    throw appError('validation_error', 'Request validation failed', 422)
  }

  const user = await findRecoveryUser(email)
  const validPassword = await passwordMatches(input.password, user?.passwordHash ?? null)
  if (!user) await bcrypt.compare(normalizedRecoveryCode, DUMMY_RECOVERY_CODE_HASH)

  const recordRecoveryFailure = async (
    db: Tx,
    auditSubject: { orgId: string | null; identityTokenId: string | null } | null,
    userId: string | null,
    reason: 'invalid_credentials' | 'invalid_recovery_code' | 'expired_recovery_code'
  ): Promise<void> => {
    await tryWriteFailedRecoverAudit(db, auditSubject, meta)
    void recordFailedAuthAttempt({
      userId,
      ipAddress: meta.ipAddress ?? '0.0.0.0',
      attemptedEmail: email,
      reason,
    })
  }

  return getDb().transaction(async (tx) => {
    const db = tx as Tx
    if (!user || !validPassword || !user.mfaEnrolledAt) {
      const orgId = user ? await activeOrgForUser(db, user.id) : null
      const auditSubject = user ? { orgId, identityTokenId: user.identityTokenId } : null
      await recordRecoveryFailure(db, auditSubject, null, 'invalid_credentials')
      throw invalidRecoveryCredentials()
    }

    const orgId = await activeOrgForUser(db, user.id)
    const auditSubject = { orgId, identityTokenId: user.identityTokenId }
    if (!orgId) {
      await recordRecoveryFailure(db, auditSubject, user.id, 'invalid_credentials')
      throw invalidRecoveryCredentials()
    }

    const matchedCodeId = await findMatchingRecoveryCode(db, user.id, normalizedRecoveryCode)
    if (!matchedCodeId) {
      await recordRecoveryFailure(db, auditSubject, user.id, 'invalid_recovery_code')
      throw invalidRecoveryCredentials()
    }

    const lockedRows = await db
      .select({ id: mfaRecoveryCodes.id })
      .from(mfaRecoveryCodes)
      .where(and(eq(mfaRecoveryCodes.id, matchedCodeId), isNull(mfaRecoveryCodes.usedAt)))
      .for('update')
      .limit(1)
    if (!lockedRows[0]) {
      await recordRecoveryFailure(db, auditSubject, user.id, 'expired_recovery_code')
      throw invalidRecoveryCredentials()
    }

    const usedAt = new Date()
    await db.update(mfaRecoveryCodes).set({ usedAt }).where(eq(mfaRecoveryCodes.id, matchedCodeId))
    const remainingRecoveryCodes = await countUnusedRecoveryCodes(user.id, db)

    await db.execute(sql`SELECT set_config('app.current_org_id', ${orgId}, true)`)
    const session = await createLoginSessionInTx(
      db,
      { id: user.id, identityTokenId: user.identityTokenId },
      orgId,
      meta
    )
    await writeAuditEntry(db, {
      orgId,
      actorTokenId: user.identityTokenId,
      eventType: AuditEvent.MFA_RECOVERY_USED,
      payload: { remainingRecoveryCodes },
      meta,
    })

    process.stdout.write(
      `${JSON.stringify({ eventType: 'alert.pending_epic3', alertType: 'mfa.recovery_used', userId: user.id })}\n`
    )

    return {
      userId: session.userId,
      orgId: session.orgId,
      expiresAt: session.expiresAt,
      remainingRecoveryCodes,
      tokens: session.tokens,
    }
  })
}

export async function getMfaStatus(
  userId: string,
  tx?: Tx
): Promise<{
  mfaEnrolled: boolean
  mfaEnrolledAt: string | null
  remainingRecoveryCodesCount: number | null
}> {
  const run = async (tx: unknown) => {
    const db = tx as Tx
    const userRows = await db
      .select({ mfaEnrolledAt: users.mfaEnrolledAt })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
    const mfaEnrolledAt = userRows[0]?.mfaEnrolledAt ?? null
    if (!mfaEnrolledAt) {
      return { mfaEnrolled: false, mfaEnrolledAt: null, remainingRecoveryCodesCount: null }
    }
    return {
      mfaEnrolled: true,
      mfaEnrolledAt: mfaEnrolledAt.toISOString(),
      remainingRecoveryCodesCount: await countUnusedRecoveryCodes(userId, db),
    }
  }
  return tx ? run(tx) : getDb().transaction(run)
}
