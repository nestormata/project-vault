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
import { currentAuditKeyVersion } from '../audit/key-version.js'
import { computeAuditHmac } from '../audit/write-entry.js'
import { getAuditKey } from '../vault/key-service.js'
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

async function actorTokenIdForUser(tx: Tx, userId: string): Promise<string | null> {
  const rows = await tx
    .select({ id: userIdentityTokens.id })
    .from(userIdentityTokens)
    .where(eq(userIdentityTokens.userId, userId))
    .limit(1)
  return rows[0]?.id ?? null
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

async function buildQrCodeSvg(otpauthUrl: string): Promise<string> {
  return QRCode.toString(otpauthUrl, { type: 'svg', margin: 2, width: 256 })
}

export async function enrollMfa(authContext: AuthContext, meta: RequestMeta = {}) {
  return getDb().transaction(async (tx) => {
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
    const secretBuffer = Buffer.from(secret.base32, 'utf8')
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
    const enrollment = enrollmentRows[0]
    if (!enrollment) throw new Error('enrollMfa: enrollment insert returned no row')

    await writeAuditEntry(db, {
      orgId: authContext.orgId,
      actorTokenId: await actorTokenIdForUser(db, authContext.userId),
      eventType: AuditEvent.MFA_ENROLLMENT_STARTED,
      resourceId: enrollment.id,
      resourceType: 'mfa_enrollment',
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
  })
}

async function loadPendingEnrollmentForUpdate(tx: Tx, userId: string) {
  const rows = await tx
    .select({
      id: mfaEnrollments.id,
      secretEncrypted: mfaEnrollments.secretEncrypted,
    })
    .from(mfaEnrollments)
    .where(and(eq(mfaEnrollments.userId, userId), eq(mfaEnrollments.status, 'pending')))
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
): Promise<void> {
  const plaintext = await decryptEnrollmentSecret(enrollment.secretEncrypted)
  try {
    const result = validateTotpCode(plaintext.toString('utf8'), totp)
    if (!result.valid || result.counter === undefined) {
      if (deletePendingOnInvalid) await deletePendingEnrollmentForUser(userId, tx)
      throw invalidTotp()
    }
    await recordTotpUse(userId, result.counter, totp, tx)
  } catch (error) {
    if (isUniqueViolation(error)) throw invalidTotp()
    throw error
  } finally {
    plaintext.fill(0)
  }
}

export async function verifyEnrollment(
  authContext: AuthContext,
  input: { totp: string },
  meta: RequestMeta = {}
) {
  return getDb().transaction(async (tx) => {
    const db = tx as Tx
    const enrollment = await loadPendingEnrollmentForUpdate(db, authContext.userId)
    if (!enrollment) {
      throw appError('mfa_enrollment_not_started', 'MFA enrollment has not been started.', 409)
    }

    await validateEnrollmentTotp(db, authContext.userId, enrollment, input.totp, true)

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
    await db
      .insert(mfaRecoveryCodes)
      .values(await recoveryCodeRows(authContext.userId, recoveryCodes))
    await writeAuditEntry(db, {
      orgId: authContext.orgId,
      actorTokenId: await actorTokenIdForUser(db, authContext.userId),
      eventType: AuditEvent.MFA_ENROLLED,
      resourceId: enrollment.id,
      resourceType: 'mfa_enrollment',
      payload: { method: 'totp' },
      meta,
    })

    return { mfaEnrolledAt: enrolledAt.toISOString(), recoveryCodes }
  })
}

export async function regenerateRecoveryCodes(
  authContext: AuthContext,
  input: { totp: string },
  meta: RequestMeta = {}
) {
  return getDb().transaction(async (tx) => {
    const db = tx as Tx
    const enrollment = await loadConfirmedEnrollmentForUpdate(db, authContext.userId)
    if (!enrollment) throw appError('mfa_not_enrolled', 'MFA is not enrolled for this user.', 409)

    await validateEnrollmentTotp(db, authContext.userId, enrollment, input.totp, false)

    const generatedAt = new Date()
    const recoveryCodes = generateRecoveryCodes(env.MFA_RECOVERY_CODE_COUNT)
    await db
      .update(mfaRecoveryCodes)
      .set({ usedAt: generatedAt })
      .where(and(eq(mfaRecoveryCodes.userId, authContext.userId), isNull(mfaRecoveryCodes.usedAt)))
    await db
      .insert(mfaRecoveryCodes)
      .values(await recoveryCodeRows(authContext.userId, recoveryCodes))
    await writeAuditEntry(db, {
      orgId: authContext.orgId,
      actorTokenId: await actorTokenIdForUser(db, authContext.userId),
      eventType: AuditEvent.MFA_RECOVERY_CODES_REGENERATED,
      resourceId: enrollment.id,
      resourceType: 'mfa_enrollment',
      payload: {
        method: 'totp',
        remainingRecoveryCodes: await countUnusedRecoveryCodes(authContext.userId, db),
      },
      meta,
    })

    return { recoveryCodes, generatedAt: generatedAt.toISOString() }
  })
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

  return getDb().transaction(async (tx) => {
    const db = tx as Tx
    const orgId = user ? await activeOrgForUser(db, user.id) : null
    const auditSubject = user ? { orgId, identityTokenId: user.identityTokenId } : null
    if (!user || !validPassword || !user.mfaEnrolledAt || !orgId) {
      await tryWriteFailedRecoverAudit(db, auditSubject, meta)
      throw invalidRecoveryCredentials()
    }

    const matchedCodeId = await findMatchingRecoveryCode(db, user.id, normalizedRecoveryCode)
    if (!matchedCodeId) {
      await tryWriteFailedRecoverAudit(db, auditSubject, meta)
      throw invalidRecoveryCredentials()
    }

    const lockedRows = await db
      .select({ id: mfaRecoveryCodes.id })
      .from(mfaRecoveryCodes)
      .where(and(eq(mfaRecoveryCodes.id, matchedCodeId), isNull(mfaRecoveryCodes.usedAt)))
      .for('update')
      .limit(1)
    if (!lockedRows[0]) {
      await tryWriteFailedRecoverAudit(db, auditSubject, meta)
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

export async function getMfaStatus(userId: string): Promise<{
  mfaEnrolled: boolean
  mfaEnrolledAt: string | null
  remainingRecoveryCodesCount: number | null
}> {
  return getDb().transaction(async (tx) => {
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
  })
}
