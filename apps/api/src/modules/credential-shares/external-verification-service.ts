import { and, eq, gt, isNotNull, isNull, lt, sql, type SQL } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { credentialShares } from '@project-vault/db/schema'
import { OperationalEvent } from '@project-vault/shared'
import { withMinResponseTime } from '../../lib/min-response-time.js'
import {
  dispatchDirectEmailNotification,
  type NotificationQueueJob,
} from '../../notifications/dispatcher.js'
import {
  adminLookupByTokenHash,
  displayNameFromEmail,
  lockShareAfterAttemptCap,
  scheduleDeferredExternalShareTask,
} from './external-service.js'
import {
  EXTERNAL_SHARE_MISS_FLOOR_MS,
  EXTERNAL_SHARE_VERIFICATION_CODE_TTL_MS,
  EXTERNAL_SHARE_VERIFICATION_MAX_ATTEMPTS,
  EXTERNAL_SHARE_VERIFICATION_MAX_SENDS,
  EXTERNAL_SHARE_VERIFICATION_RESEND_COOLDOWN_SECONDS,
} from './schema.js'
import { hashShareToken, shareWithCredentialAndSharerQuery } from './service.js'
import {
  generateVerificationCode,
  generateVerificationProof,
  hashVerificationCode,
  maskedRecipientFor,
  verificationCodeMatches,
} from './verification.js'

/**
 * Story 72-11 — guest recipient verification for native external shares (decisions V3-V9).
 *
 * Two unauthenticated routes sit in front of the reveal of a gated share: a send (emails a 6-digit
 * code) and a confirm (trades the code for a one-time proof the reveal requires). Neither may tell
 * a live link from a dead one: the send always answers the same body and does its work after the
 * response (V5); the confirm answers one identical failure for every non-success (V7); and every
 * outcome of both is held to `EXTERNAL_SHARE_MISS_FLOOR_MS` (V9). The confirm's attempt reservation
 * is deliberately synchronous (V4): the code has 20 bits, so a parallel burst of guesses must never
 * get more than five compares. The code is never logged, audited or returned.
 */

export const VERIFICATION_CODE_TEMPLATE_ID = 'credential_share.verification_code'

type VerificationLogger = Parameters<typeof scheduleDeferredExternalShareTask>[1]

/** Hands the queued email rows to the delivery queue after the deferred transaction committed. */
export type VerificationDispatch = (jobs: NotificationQueueJob[]) => Promise<void>

export type RequestVerificationResult = { maskedRecipient: string; cooldownSeconds: number }

export type ConfirmVerificationResult = { status: 'ok'; proof: string } | { status: 'failed' }

const FAILED: ConfirmVerificationResult = { status: 'failed' }

/** A gated share a guest may still verify: active, before its expiry, not locked and under the
 *  attempt cap. Evaluated inside the UPDATE, so it is re-checked under the row lock. */
function verifiableShareCondition(shareId: string): SQL | undefined {
  return and(
    eq(credentialShares.id, shareId),
    eq(credentialShares.verificationRequired, true),
    eq(credentialShares.status, 'active'),
    gt(credentialShares.expiresAt, sql`now()`),
    isNull(credentialShares.lockedAt),
    lt(credentialShares.verificationAttemptCount, EXTERNAL_SHARE_VERIFICATION_MAX_ATTEMPTS)
  )
}

/**
 * V5, the deferred half of the send: one transaction that stores the new code's hash (replacing,
 * and so invalidating, any previous code), counts the send, and queues the plain-text email. The
 * cooldown and the send cap are part of the UPDATE's WHERE, so two racing sends cannot both pass.
 * Nothing is written for a share that is not verifiable, throttled or over the cap.
 */
async function sendVerificationCode(
  rawToken: string,
  target: { orgId: string; shareId: string },
  dispatch: VerificationDispatch
): Promise<void> {
  const code = generateVerificationCode()
  const jobs = await withOrg(target.orgId, async (tx) => {
    const [updated] = await tx
      .update(credentialShares)
      .set({
        verificationCodeHash: hashVerificationCode(rawToken, target.shareId, code),
        verificationCodeExpiresAt: sql`now() + make_interval(secs => ${EXTERNAL_SHARE_VERIFICATION_CODE_TTL_MS / 1000})`,
        verificationSendCount: sql`${credentialShares.verificationSendCount} + 1`,
        verificationSentAt: sql`now()`,
      })
      .where(
        and(
          verifiableShareCondition(target.shareId),
          lt(credentialShares.verificationSendCount, EXTERNAL_SHARE_VERIFICATION_MAX_SENDS),
          sql`(${credentialShares.verificationSentAt} IS NULL OR ${credentialShares.verificationSentAt} <= now() - make_interval(secs => ${EXTERNAL_SHARE_VERIFICATION_RESEND_COOLDOWN_SECONDS}))`
        )
      )
      .returning({ id: credentialShares.id, recipientEmail: credentialShares.recipientEmail })
    if (!updated?.recipientEmail) return []

    const [joined] = await shareWithCredentialAndSharerQuery(tx)
      .where(eq(credentialShares.id, updated.id))
      .limit(1)
    // V11: the code and the sharer's display name only. No link, no token, no credential name.
    return dispatchDirectEmailNotification({
      orgId: target.orgId,
      recipientEmail: updated.recipientEmail,
      template: {
        templateId: VERIFICATION_CODE_TEMPLATE_ID,
        payload: { code, sharedByDisplayName: displayNameFromEmail(joined?.sharedByEmail ?? null) },
        severity: 'info',
      },
      tx,
    })
  })
  await dispatch(jobs)
}

/**
 * V5/V6: `POST /access/:token/verification`. One admin lookup for every class, then the same
 * answer for all of them: the masked address (the real recipient's when the token resolves to an
 * external share, a deterministic synthetic one otherwise) and the cooldown. A gated share
 * schedules the tracked deferred send; whether it actually sends is decided in that transaction.
 */
export async function requestExternalShareVerification(
  rawToken: string,
  deps: { logger: VerificationLogger; dispatch: VerificationDispatch }
): Promise<RequestVerificationResult> {
  const row = await adminLookupByTokenHash(hashShareToken(rawToken))
  const external = row?.recipientType === 'external' ? row : null
  const live = external?.verificationRequired === true && external.status === 'active'
  if (external?.verificationRequired) {
    const target = { orgId: external.orgId, shareId: external.id }
    scheduleDeferredExternalShareTask(
      () => sendVerificationCode(rawToken, target, deps.dispatch),
      deps.logger,
      {
        eventType: OperationalEvent.CREDENTIAL_SHARE_VERIFICATION_SEND_FAILED,
        message: 'Deferred external share verification-code send failed',
      }
    )
  }
  return {
    maskedRecipient: maskedRecipientFor(
      rawToken,
      external && live ? external.recipientEmail : null
    ),
    cooldownSeconds: EXTERNAL_SHARE_VERIFICATION_RESEND_COOLDOWN_SECONDS,
  }
}

/**
 * V4/V7/V8: `POST /access/:token/verification/confirm`. The attempt is reserved atomically BEFORE
 * the compare (`verification_attempt_count < 5` in the UPDATE's WHERE, under the row lock), so a
 * parallel burst cannot exceed five compares; only a share with a live, unexpired code can be
 * guessed against at all. A success refunds its reservation (the budget counts failures), clears
 * the code (single use) and stores the proof's hash. The fifth failure revokes and locks the share
 * in the same transaction. Every other outcome is the same `failed`.
 */
export async function confirmExternalShareVerification(
  rawToken: string,
  code: string
): Promise<ConfirmVerificationResult> {
  const row = await adminLookupByTokenHash(hashShareToken(rawToken))
  if (row?.recipientType !== 'external' || !row.verificationRequired) return FAILED

  return withOrg(row.orgId, async (tx): Promise<ConfirmVerificationResult> => {
    const [reserved] = await tx
      .update(credentialShares)
      .set({ verificationAttemptCount: sql`${credentialShares.verificationAttemptCount} + 1` })
      .where(
        and(
          verifiableShareCondition(row.id),
          isNotNull(credentialShares.verificationCodeHash),
          gt(credentialShares.verificationCodeExpiresAt, sql`now()`)
        )
      )
      .returning()
    if (!reserved) return FAILED

    if (verificationCodeMatches(rawToken, reserved.id, code, reserved.verificationCodeHash)) {
      const { proof, proofHash } = generateVerificationProof()
      await tx
        .update(credentialShares)
        .set({
          verificationAttemptCount: sql`${credentialShares.verificationAttemptCount} - 1`,
          verificationCodeHash: null,
          verificationCodeExpiresAt: null,
          verificationProofHash: proofHash,
          verifiedAt: sql`now()`,
        })
        .where(eq(credentialShares.id, reserved.id))
      return { status: 'ok', proof }
    }

    if (reserved.verificationAttemptCount >= EXTERNAL_SHARE_VERIFICATION_MAX_ATTEMPTS) {
      await lockShareAfterAttemptCap(tx, reserved, 'verification_attempts_exhausted')
    }
    return FAILED
  })
}

/** V9: every outcome of the send is held to the floor. */
export function requestExternalShareVerificationWithFloor(
  rawToken: string,
  deps: { logger: VerificationLogger; dispatch: VerificationDispatch }
): Promise<RequestVerificationResult> {
  return withMinResponseTime(
    EXTERNAL_SHARE_MISS_FLOOR_MS,
    () => requestExternalShareVerification(rawToken, deps),
    { isMiss: () => true }
  )
}

/** V9: every outcome of the confirm, success included, is held to the floor. */
export function confirmExternalShareVerificationWithFloor(
  rawToken: string,
  code: string
): Promise<ConfirmVerificationResult> {
  return withMinResponseTime(
    EXTERNAL_SHARE_MISS_FLOOR_MS,
    () => confirmExternalShareVerification(rawToken, code),
    { isMiss: () => true }
  )
}
