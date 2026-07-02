import type { FastifyRequest } from 'fastify'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { getDb, type Tx } from '@project-vault/db'
import {
  accountRecoveryTokens,
  mfaEnrollments,
  mfaRecoveryCodes,
  notificationQueue,
  orgMemberships,
  organizations,
  users,
} from '@project-vault/db/schema'
import { AuditEvent } from '@project-vault/shared'
import { env } from '../../config/env.js'
import { AppError } from '../../lib/errors.js'
import { writeHumanAuditEntryOrFailClosed } from '../../lib/audit-or-fail-closed.js'
import { normalizeEmail } from './normalize.js'
import { hashUserPassword } from './password.js'
import {
  buildQrCodeSvg,
  insertRecoveryCodes,
  loadPendingEnrollmentForUpdate,
  validateEnrollmentTotp,
} from './mfa.js'
import { deletePendingEnrollmentForUser, generateRecoveryCodes } from './recovery-codes.js'
import { revokeAllUserSessionsInOrg } from './session-revoke.js'
import {
  claimRecoveryToken,
  findRecoveryTokenByHash,
  supersedePriorRecoveryTokens,
  validateRecoveryTokenStatus,
  type RecoveryTokenStatusError,
} from './recovery-lookup.js'
import { generateRecoveryToken, hashRecoveryToken, maskRecoveryEmail } from './recovery-tokens.js'
import { buildOtpAuthUrl, encryptTotpSecret, generateSecret } from './totp.js'

const RECOVERY_TOKEN_TTL_MS = 15 * 60 * 1000
const RECOVERY_TOKEN_NOT_FOUND_MESSAGE = 'Recovery link not found'

/**
 * org_memberships is RLS-scoped and the caller's org(s) are unknown ahead of time here (a
 * recovering user may belong to several orgs — D2), so there is no single org context to set for
 * a normal withOrg() scan. Mirrors mfa.ts's activeOrgForUser: iterate every org, flipping
 * app.current_org_id per row, and collect the ones where this user has an active membership —
 * same pre-org-resolution tradeoff already accepted in this codebase for the sibling recovery-
 * code flow, just generalized to return every matching org instead of the first one.
 */
async function activeOrgMembershipsForUser(
  tx: Tx,
  userId: string
): Promise<{ orgId: string; hasReachableAdmin: boolean }[]> {
  const orgRows = await tx.select({ orgId: organizations.id }).from(organizations)
  const memberships: { orgId: string; hasReachableAdmin: boolean }[] = []
  for (const { orgId } of orgRows) {
    await tx.execute(sql`SELECT set_config('app.current_org_id', ${orgId}, true)`)
    const [membership] = await tx
      .select({ role: orgMemberships.role })
      .from(orgMemberships)
      .where(
        and(
          eq(orgMemberships.userId, userId),
          eq(orgMemberships.orgId, orgId),
          eq(orgMemberships.status, 'active')
        )
      )
      .limit(1)
    if (!membership) continue
    const [adminRow] = await tx
      .select({ userId: orgMemberships.userId })
      .from(orgMemberships)
      .where(
        and(
          eq(orgMemberships.orgId, orgId),
          eq(orgMemberships.status, 'active'),
          inArray(orgMemberships.role, ['owner', 'admin'])
        )
      )
      .limit(1)
    memberships.push({ orgId, hasReachableAdmin: Boolean(adminRow) })
  }
  return memberships
}

/** AC-9 step 2-3 / AC-10: creates a fresh recovery token, superseding any prior live one. */
async function createRecoveryToken(
  tx: Tx,
  input: {
    userId: string
    initiatedBy: 'self' | 'admin'
    initiatorUserId?: string
    initiatorOrgId?: string
  }
): Promise<{ opaqueToken: string; expiresAt: Date }> {
  await supersedePriorRecoveryTokens(tx, input.userId)

  const opaqueToken = generateRecoveryToken()
  const expiresAt = new Date(Date.now() + RECOVERY_TOKEN_TTL_MS)
  await tx.insert(accountRecoveryTokens).values({
    userId: input.userId,
    tokenHash: hashRecoveryToken(opaqueToken),
    initiatedBy: input.initiatedBy,
    initiatorUserId: input.initiatorUserId ?? null,
    initiatorOrgId: input.initiatorOrgId ?? null,
    expiresAt,
  })
  return { opaqueToken, expiresAt }
}

function recoveryLinkUrl(opaqueToken: string): string {
  return `${env.WEB_BASE_URL.replace(/\/+$/, '')}/recovery/${opaqueToken}`
}

/**
 * Distinct templateIds/copy for the self- vs. admin-initiated path (adversarial review MEDIUM) —
 * an admin-sent link and a self-requested one carry different anti-phishing framing ("your admin
 * sent you this" vs. "you requested this").
 */
async function enqueueRecoveryEmail(
  tx: Tx,
  input: {
    orgId: string
    recipientEmail: string
    opaqueToken: string
    kind: 'self' | 'admin'
    initiatorEmail?: string | null
  }
): Promise<void> {
  // notification_queue is RLS-scoped; set context explicitly rather than relying on whatever the
  // caller's transaction last left app.current_org_id as (see activeOrgMembershipsForUser).
  await tx.execute(sql`SELECT set_config('app.current_org_id', ${input.orgId}, true)`)
  await tx.insert(notificationQueue).values({
    orgId: input.orgId,
    recipientUserId: null,
    recipientEmail: input.recipientEmail,
    channel: 'email',
    templateId: input.kind === 'self' ? 'auth.recovery_link_created' : 'auth.recovery_link_sent',
    payload: {
      recoveryUrl: recoveryLinkUrl(input.opaqueToken),
      initiatorEmail: input.initiatorEmail ?? null,
    },
    status: 'pending',
  })
}

async function writeRecoveryAuditPerOrg(
  tx: Tx,
  input: {
    orgIds: string[]
    actorUserId: string
    eventType: string
    payload: Record<string, unknown>
    request: FastifyRequest
  }
): Promise<void> {
  for (const orgId of input.orgIds) {
    await writeHumanAuditEntryOrFailClosed(tx, {
      resourceType: 'account_recovery',
      orgId,
      actorUserId: input.actorUserId,
      eventType: input.eventType,
      payload: input.payload,
      request: input.request,
    })
  }
}

export type RequestRecoveryResult = { blocked: boolean }

/**
 * AC-9/AC-11/AC-12: self-initiated recovery request. Always performs the same full user +
 * org-membership lookup shape on a miss as on a hit (AC-9's own edge case) to avoid a trivial
 * early-return timing tell; the residual write-count timing gap on a real hit (N audit rows for
 * an N-org user) is a known, accepted limitation — see the adversarial review for this story.
 */
export async function requestSelfRecovery(
  email: string,
  request: FastifyRequest
): Promise<RequestRecoveryResult> {
  const normalized = normalizeEmail(email)

  return getDb().transaction(async (rawTx) => {
    const secureCtx = { tx: rawTx as Tx }
    const [user] = await secureCtx.tx
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.email, normalized))
      .limit(1)

    // eslint-disable-next-line no-secrets/no-secrets -- nil UUID placeholder, not a secret.
    const targetUserId = user?.id ?? '00000000-0000-0000-0000-000000000000'
    const memberships = await activeOrgMembershipsForUser(secureCtx.tx, targetUserId)
    if (!user) return { blocked: false }
    if (memberships.length === 0) return { blocked: false }

    const hasAnyAdmin = memberships.some((m) => m.hasReachableAdmin)

    if (!hasAnyAdmin) {
      await writeRecoveryAuditPerOrg(secureCtx.tx, {
        orgIds: memberships.map((m) => m.orgId),
        actorUserId: user.id,
        eventType: AuditEvent.ACCOUNT_RECOVERY_BLOCKED,
        payload: { targetUserId: user.id, initiatedBy: 'self' },
        request,
      })
      return { blocked: true }
    }

    const { opaqueToken } = await createRecoveryToken(secureCtx.tx, {
      userId: user.id,
      initiatedBy: 'self',
    })
    await enqueueRecoveryEmail(secureCtx.tx, {
      orgId: memberships[0]?.orgId as string,
      recipientEmail: user.email,
      opaqueToken,
      kind: 'self',
    })
    await writeRecoveryAuditPerOrg(secureCtx.tx, {
      orgIds: memberships.map((m) => m.orgId),
      actorUserId: user.id,
      eventType: AuditEvent.ACCOUNT_RECOVERY_REQUESTED,
      payload: { targetUserId: user.id, initiatedBy: 'self' },
      request,
    })
    return { blocked: false }
  })
}

/** AC-10: admin-initiated recovery link. Runs inside the caller's own secureCtx.tx. */
export async function sendAdminRecoveryLink(
  tx: Tx,
  input: {
    targetUserId: string
    targetEmail: string
    initiatorOrgId: string
    initiatorEmail: string
  }
): Promise<void> {
  const { opaqueToken } = await createRecoveryToken(tx, {
    userId: input.targetUserId,
    initiatedBy: 'admin',
    initiatorOrgId: input.initiatorOrgId,
  })
  await enqueueRecoveryEmail(tx, {
    orgId: input.initiatorOrgId,
    recipientEmail: input.targetEmail,
    opaqueToken,
    kind: 'admin',
    initiatorEmail: input.initiatorEmail,
  })
}

export type RecoveryPeek =
  | { ok: true; email: string; mfaCurrentlyEnrolled: boolean }
  | { ok: false; error: RecoveryTokenStatusError }

/** AC-13: public token peek — masked email, no mutation. */
export async function peekRecoveryToken(token: string): Promise<RecoveryPeek> {
  const found = await findRecoveryTokenByHash(hashRecoveryToken(token))
  const statusError = validateRecoveryTokenStatus(found)
  if (statusError) return { ok: false, error: statusError }
  const record = found as NonNullable<typeof found>

  const [user] = await getDb()
    .select({ email: users.email, mfaEnrolledAt: users.mfaEnrolledAt })
    .from(users)
    .where(eq(users.id, record.userId))
    .limit(1)
  if (!user) {
    return {
      ok: false,
      error: {
        code: 'recovery_token_not_found',
        message: RECOVERY_TOKEN_NOT_FOUND_MESSAGE,
        statusCode: 404,
      },
    }
  }

  return {
    ok: true,
    email: maskRecoveryEmail(user.email),
    mfaCurrentlyEnrolled: Boolean(user.mfaEnrolledAt),
  }
}

export type RecoveryMfaStartResult =
  | { ok: true; otpauthUrl: string; secret: string; qrCodeSvg: string }
  | { ok: false; error: RecoveryTokenStatusError }

/**
 * AC-15/D1: stages a fresh TOTP secret for the recovery token's user, mirroring enrollMfa's body
 * without a session-bound AuthContext. Does not consume the recovery token and does not touch a
 * pre-existing *confirmed* enrollment — only completion (with a verified totpCode) replaces it,
 * so an abandoned mfa/start call never silently strips a still-working MFA enrollment.
 */
export async function startRecoveryMfa(token: string): Promise<RecoveryMfaStartResult> {
  const found = await findRecoveryTokenByHash(hashRecoveryToken(token))
  const statusError = validateRecoveryTokenStatus(found)
  if (statusError) return { ok: false, error: statusError }
  const record = found as NonNullable<typeof found>

  return getDb().transaction(async (rawTx) => {
    const tx = rawTx as Tx
    const [user] = await tx
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.id, record.userId))
      .limit(1)
    if (!user) {
      return {
        ok: false,
        error: {
          code: 'recovery_token_not_found' as const,
          message: RECOVERY_TOKEN_NOT_FOUND_MESSAGE,
          statusCode: 404 as const,
        },
      }
    }

    await deletePendingEnrollmentForUser(user.id, tx)
    const secret = generateSecret()
    const secretBuffer = Buffer.from(secret.buffer)
    const encrypted = await encryptTotpSecret(secretBuffer)
    secretBuffer.fill(0)

    await tx.insert(mfaEnrollments).values({
      userId: user.id,
      secretEncrypted: encrypted,
      status: 'pending',
      label: 'Authenticator',
    })

    const otpauthUrl = buildOtpAuthUrl(secret.base32, user.email)
    return {
      ok: true as const,
      otpauthUrl,
      secret: secret.base32,
      qrCodeSvg: await buildQrCodeSvg(otpauthUrl),
    }
  })
}

export type RecoveryCompleteResult =
  | {
      ok: true
      email: string
      sessionsRevoked: number
      mfaReEnrolled: boolean
      recoveryCodes?: string[]
    }
  | { ok: false; error: { code: string; message: string; statusCode: number } }

async function verifyStagedTotpOrFail(
  tx: Tx,
  userId: string,
  totpCode: string
): Promise<{ enrollmentId: string } | { failed: true; code: string; message: string }> {
  const enrollment = await loadPendingEnrollmentForUpdate(tx, userId)
  if (!enrollment) {
    return { failed: true, code: 'mfa_not_staged', message: 'MFA re-enrollment was not started.' }
  }
  const result = await validateEnrollmentTotp(tx, userId, enrollment, totpCode, false)
  if (result !== 'valid') {
    return {
      failed: true,
      code: 'invalid_totp_code',
      message: 'The authenticator code is incorrect.',
    }
  }
  return { enrollmentId: enrollment.id }
}

async function promoteStagedEnrollmentAndReissueCodes(
  tx: Tx,
  userId: string,
  enrollmentId: string
): Promise<string[]> {
  const confirmedAt = new Date()
  // Avoid violating idx_mfa_enrollments_user_confirmed (one confirmed row per user) — replace,
  // don't stack, any prior confirmed enrollment (adversarial review LOW finding).
  await tx
    .delete(mfaEnrollments)
    .where(and(eq(mfaEnrollments.userId, userId), eq(mfaEnrollments.status, 'confirmed')))
  await tx
    .update(mfaEnrollments)
    .set({ status: 'confirmed', confirmedAt })
    .where(eq(mfaEnrollments.id, enrollmentId))
  await tx.update(users).set({ mfaEnrolledAt: confirmedAt }).where(eq(users.id, userId))

  // Adversarial review HIGH-1: issue a fresh recovery-code batch on re-enrollment confirm, same
  // as verifyEnrollment does — otherwise a user recovering from "lost device + exhausted codes"
  // ends up with zero codes again. Invalidate any still-unused old codes first (mirrors
  // regenerateRecoveryCodes).
  await tx
    .update(mfaRecoveryCodes)
    .set({ usedAt: confirmedAt })
    .where(and(eq(mfaRecoveryCodes.userId, userId), isNull(mfaRecoveryCodes.usedAt)))
  const recoveryCodes = generateRecoveryCodes(env.MFA_RECOVERY_CODE_COUNT)
  await insertRecoveryCodes(tx, userId, recoveryCodes)
  return recoveryCodes
}

/** AC-14/AC-15/AC-19: password reset + optional MFA confirm + multi-org session revocation. */
export async function completeAccountRecovery(
  token: string,
  input: { newPassword: string; totpCode?: string },
  request: FastifyRequest
): Promise<RecoveryCompleteResult> {
  const found = await findRecoveryTokenByHash(hashRecoveryToken(token))
  const statusError = validateRecoveryTokenStatus(found)
  if (statusError) {
    return { ok: false, error: statusError }
  }
  const record = found as NonNullable<typeof found>

  return getDb().transaction(async (rawTx) => {
    const secureCtx = { tx: rawTx as Tx }

    const claimed = await claimRecoveryToken(secureCtx.tx, record.id)
    if (!claimed) {
      return {
        ok: false as const,
        error: {
          code: 'recovery_token_already_used',
          message: 'This recovery link was already used',
          statusCode: 409,
        },
      }
    }

    const [user] = await secureCtx.tx
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.id, claimed.userId))
      .limit(1)
    if (!user) throw new AppError('recovery_token_not_found', RECOVERY_TOKEN_NOT_FOUND_MESSAGE, 404)

    let mfaReEnrolled = false
    let recoveryCodes: string[] | undefined
    if (input.totpCode) {
      const totpResult = await verifyStagedTotpOrFail(secureCtx.tx, user.id, input.totpCode)
      if ('failed' in totpResult) {
        throw new AppError(totpResult.code, totpResult.message, 422)
      }
      recoveryCodes = await promoteStagedEnrollmentAndReissueCodes(
        secureCtx.tx,
        user.id,
        totpResult.enrollmentId
      )
      mfaReEnrolled = true
    }

    const passwordHash = await hashUserPassword(input.newPassword)
    await secureCtx.tx.update(users).set({ passwordHash }).where(eq(users.id, user.id))

    const memberships = await activeOrgMembershipsForUser(secureCtx.tx, user.id)
    let sessionsRevoked = 0
    for (const membership of memberships) {
      const result = await revokeAllUserSessionsInOrg({
        userId: user.id,
        orgId: membership.orgId,
        actorUserId: user.id,
        reason: 'account_recovery',
        tx: secureCtx.tx,
      })
      sessionsRevoked += result.revokedCount
    }

    await writeRecoveryAuditPerOrg(secureCtx.tx, {
      orgIds: memberships.map((m) => m.orgId),
      actorUserId: user.id,
      eventType: AuditEvent.ACCOUNT_RECOVERY_COMPLETED,
      payload: { targetUserId: user.id, sessionsRevoked, mfaReEnrolled },
      request,
    })

    return {
      ok: true as const,
      email: user.email,
      sessionsRevoked,
      mfaReEnrolled,
      recoveryCodes,
    }
  })
}
