import { and, count, eq } from 'drizzle-orm'
import { getDb, type Tx } from '@project-vault/db'
import {
  mfaEnrollments,
  securityAlerts,
  users,
  webauthnCredentials,
  webauthnRegistrationChallenges,
} from '@project-vault/db/schema'
import { AuditEvent, SecurityAlertType } from '@project-vault/shared'
import { env } from '../../config/env.js'
import { AppError } from '../../lib/errors.js'
import { firstActorTokenIdForUser } from '../audit/actor-token.js'
import { writeHumanAuditEntry } from '../audit/human-entry.js'
import type { RequestMeta } from './service.js'
import {
  LAST_SECOND_FACTOR_REQUIRED_MESSAGE,
  WEBAUTHN_CHALLENGE_TTL_MS,
  WEBAUTHN_REQUIRES_TOTP_MESSAGE,
  lastFactorRemovalBlocked,
  parseAuthenticatorName,
  relyingPartyFromCors,
} from './webauthn-policy.js'
import {
  createRegistrationOptions,
  verifyAttestation,
  type WebAuthnAttestation,
} from './webauthn-lib.js'

type WebAuthnAuth = {
  userId: string
  orgId: string
  orgRole?: 'owner' | 'admin' | 'member' | 'viewer'
}

function appError(code: string, message: string, statusCode: number): AppError {
  return new AppError(code, message, statusCode)
}

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const code = (current as { code?: unknown }).code
    if (code === '23505') return true
    current = (current as { cause?: unknown }).cause
  }
  return false
}

function publicKeyToBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

async function requireTotpEnrolled(tx: Tx, userId: string): Promise<{ email: string }> {
  const userRows = await tx
    .select({
      email: users.email,
      mfaEnrolledAt: users.mfaEnrolledAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  const user = userRows[0]
  if (!user) throw appError('user_not_found', 'User not found', 404)
  const totpRows = await tx
    .select({ id: mfaEnrollments.id })
    .from(mfaEnrollments)
    .where(and(eq(mfaEnrollments.userId, userId), eq(mfaEnrollments.status, 'confirmed')))
    .limit(1)
  if (!user.mfaEnrolledAt || !totpRows[0]) {
    throw appError('webauthn_requires_totp', WEBAUTHN_REQUIRES_TOTP_MESSAGE, 403)
  }
  return { email: user.email }
}

async function readMfaEnrolledAt(tx: Tx, userId: string): Promise<Date | null> {
  const rows = await tx
    .select({ mfaEnrolledAt: users.mfaEnrolledAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  return rows[0]?.mfaEnrolledAt ?? null
}

async function consumeRegistrationChallenge(
  tx: Tx,
  userId: string,
  challengeId: string
): Promise<{ id: string; challenge: string }> {
  const challengeRows = await tx
    .select()
    .from(webauthnRegistrationChallenges)
    .where(
      and(
        eq(webauthnRegistrationChallenges.id, challengeId),
        eq(webauthnRegistrationChallenges.userId, userId)
      )
    )
    .for('update')
    .limit(1)
  const challenge = challengeRows[0]
  if (!challenge || challenge.expiresAt.getTime() <= Date.now()) {
    if (challenge) {
      await tx
        .delete(webauthnRegistrationChallenges)
        .where(eq(webauthnRegistrationChallenges.id, challenge.id))
    }
    throw appError(
      'webauthn_challenge_expired',
      'The hardware key registration challenge expired. Start again.',
      422
    )
  }
  await tx
    .delete(webauthnRegistrationChallenges)
    .where(eq(webauthnRegistrationChallenges.id, challenge.id))
  return challenge
}

async function insertWebauthnCredentialRow(
  tx: Tx,
  values: {
    userId: string
    credentialId: string
    publicKey: string
    signCount: number
    transports: string | null
    aaguid: string | null
    name: string
  }
): Promise<{ id: string; name: string; createdAt: Date }> {
  try {
    const inserted = await tx.transaction(async (inner) =>
      inner.insert(webauthnCredentials).values(values).returning({
        id: webauthnCredentials.id,
        name: webauthnCredentials.name,
        createdAt: webauthnCredentials.createdAt,
      })
    )
    const row = inserted[0]
    if (!row) throw new Error('webauthn register: insert returned no row')
    return row
  } catch (error: unknown) {
    if (isUniqueViolation(error)) {
      throw appError('webauthn_credential_exists', 'This hardware key is already registered.', 409)
    }
    throw error
  }
}

async function writeWebauthnAudit(
  tx: Tx,
  auth: WebAuthnAuth,
  fields: {
    eventType: string
    resourceId?: string
    payload: Record<string, unknown>
    meta: RequestMeta
  }
): Promise<void> {
  await writeHumanAuditEntry(tx, {
    orgId: auth.orgId,
    actorTokenId: await firstActorTokenIdForUser(tx, auth.userId),
    eventType: fields.eventType,
    resourceId: fields.resourceId,
    resourceType: 'webauthn_credential',
    payload: fields.payload,
    meta: fields.meta,
  })
}

export async function reportClonedAuthenticator(
  tx: Tx,
  input: {
    orgId: string
    userId: string
    credentialRowId: string
    storedCounter: number
    observedCounter: number
    meta?: RequestMeta
  }
): Promise<void> {
  try {
    await tx.insert(securityAlerts).values({
      orgId: input.orgId,
      alertType: SecurityAlertType.WEBAUTHN_CLONED_AUTHENTICATOR,
      severity: 'critical',
      status: 'PENDING_DELIVERY',
      payload: {
        credentialId: input.credentialRowId,
        storedCounter: input.storedCounter,
        observedCounter: input.observedCounter,
      },
    })
    await writeHumanAuditEntry(tx, {
      orgId: input.orgId,
      actorTokenId: await firstActorTokenIdForUser(tx, input.userId),
      eventType: AuditEvent.WEBAUTHN_CLONED_AUTHENTICATOR,
      resourceId: input.credentialRowId,
      resourceType: 'webauthn_credential',
      payload: {
        credentialId: input.credentialRowId,
        storedCounter: input.storedCounter,
        observedCounter: input.observedCounter,
      },
      meta: input.meta ?? {},
    })
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        eventType: 'auth.webauthn_cloned_alert_failed',
        error: error instanceof Error ? error.message : String(error),
        credentialId: input.credentialRowId,
      })}\n`
    )
  }
}

export function startWebauthnRegistration(auth: WebAuthnAuth, meta: RequestMeta = {}, tx?: Tx) {
  const run = async (db: unknown) => {
    const tx = db as Tx
    const user = await requireTotpEnrolled(tx, auth.userId)
    const existing = await tx
      .select({ credentialId: webauthnCredentials.credentialId })
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.userId, auth.userId))
    const rp = relyingPartyFromCors(env.CORS_ALLOWED_ORIGINS)
    const { challenge, options } = await createRegistrationOptions({
      rpName: 'Project Vault',
      rpID: rp.rpID,
      userName: user.email,
      userID: new TextEncoder().encode(auth.userId),
      excludeCredentialIds: existing.map((row) => row.credentialId),
    })
    const expiresAt = new Date(Date.now() + WEBAUTHN_CHALLENGE_TTL_MS)
    const rows = await tx
      .insert(webauthnRegistrationChallenges)
      .values({
        userId: auth.userId,
        challenge,
        expiresAt,
      })
      .onConflictDoUpdate({
        target: webauthnRegistrationChallenges.userId,
        set: { challenge, expiresAt, createdAt: new Date() },
      })
      .returning({ id: webauthnRegistrationChallenges.id })
    const challengeRow = rows[0]
    if (!challengeRow) throw new Error('webauthn options: challenge insert returned no row')
    await writeWebauthnAudit(tx, auth, {
      eventType: AuditEvent.WEBAUTHN_REGISTRATION_STARTED,
      resourceId: challengeRow.id,
      payload: { challengeId: challengeRow.id },
      meta,
    })
    return { options, challengeId: challengeRow.id }
  }
  return tx ? run(tx) : getDb().transaction(run)
}

export function completeWebauthnRegistration(
  auth: WebAuthnAuth,
  body: { challengeId: string; name: string; attestation: unknown },
  meta: RequestMeta = {},
  tx?: Tx
) {
  const run = async (db: unknown) => {
    const tx = db as Tx
    const enrolledAtBefore = await readMfaEnrolledAt(tx, auth.userId)
    await requireTotpEnrolled(tx, auth.userId)
    const name = parseAuthenticatorName(body.name)
    if (!name) {
      throw appError('validation_error', 'Authenticator name must be 1 to 64 characters.', 422)
    }
    const challenge = await consumeRegistrationChallenge(tx, auth.userId, body.challengeId)
    const rp = relyingPartyFromCors(env.CORS_ALLOWED_ORIGINS)
    const verified = await verifyAttestation({
      response: body.attestation as WebAuthnAttestation,
      expectedChallenge: challenge.challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
    })
    if (!verified.verified) {
      throw appError('webauthn_verification_failed', 'The hardware key could not be verified.', 422)
    }
    const row = await insertWebauthnCredentialRow(tx, {
      userId: auth.userId,
      credentialId: verified.credentialId,
      publicKey: publicKeyToBase64Url(verified.publicKey),
      signCount: verified.signCount,
      transports: verified.transports?.join(',') ?? null,
      aaguid: verified.aaguid ?? null,
      name,
    })
    await writeWebauthnAudit(tx, auth, {
      eventType: AuditEvent.WEBAUTHN_CREDENTIAL_REGISTERED,
      resourceId: row.id,
      payload: { credentialId: row.id, name: row.name },
      meta,
    })
    const enrolledAtAfter = await readMfaEnrolledAt(tx, auth.userId)
    if (enrolledAtAfter?.getTime() !== enrolledAtBefore?.getTime()) {
      throw new Error('webauthn register must not write mfa_enrolled_at')
    }
    return { id: row.id, name: row.name, createdAt: row.createdAt.toISOString() }
  }
  return tx ? run(tx) : getDb().transaction(run)
}

export function listWebauthnCredentials(auth: WebAuthnAuth, tx?: Tx) {
  const run = async (db: unknown) => {
    const tx = db as Tx
    const rows = await tx
      .select({
        id: webauthnCredentials.id,
        name: webauthnCredentials.name,
        createdAt: webauthnCredentials.createdAt,
        lastUsedAt: webauthnCredentials.lastUsedAt,
        signCount: webauthnCredentials.signCount,
      })
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.userId, auth.userId))
    return {
      credentials: rows.map((row) => ({
        id: row.id,
        name: row.name,
        createdAt: row.createdAt.toISOString(),
        lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
        signCount: row.signCount,
      })),
    }
  }
  return tx ? run(tx) : getDb().transaction(run)
}

export function renameWebauthnCredential(
  auth: WebAuthnAuth,
  credentialId: string,
  rawName: unknown,
  meta: RequestMeta = {},
  tx?: Tx
) {
  const run = async (db: unknown) => {
    const tx = db as Tx
    const name = parseAuthenticatorName(rawName)
    if (!name) {
      throw appError('validation_error', 'Authenticator name must be 1 to 64 characters.', 422)
    }
    const updated = await tx
      .update(webauthnCredentials)
      .set({ name })
      .where(
        and(eq(webauthnCredentials.id, credentialId), eq(webauthnCredentials.userId, auth.userId))
      )
      .returning({ id: webauthnCredentials.id, name: webauthnCredentials.name })
    const row = updated[0]
    if (!row) throw appError('not_found', 'Hardware key not found.', 404)
    await writeWebauthnAudit(tx, auth, {
      eventType: AuditEvent.WEBAUTHN_CREDENTIAL_RENAMED,
      resourceId: row.id,
      payload: { credentialId: row.id, name: row.name },
      meta,
    })
    return { id: row.id, name: row.name }
  }
  return tx ? run(tx) : getDb().transaction(run)
}

async function remainingSecondFactors(tx: Tx, userId: string): Promise<number> {
  const [totp] = await tx
    .select({ n: count() })
    .from(mfaEnrollments)
    .where(and(eq(mfaEnrollments.userId, userId), eq(mfaEnrollments.status, 'confirmed')))
  const [keys] = await tx
    .select({ n: count() })
    .from(webauthnCredentials)
    .where(eq(webauthnCredentials.userId, userId))
  return Number(totp?.n ?? 0) + Number(keys?.n ?? 0)
}

export function deleteWebauthnCredential(
  auth: WebAuthnAuth,
  credentialId: string,
  meta: RequestMeta = {},
  tx?: Tx
) {
  const run = async (db: unknown) => {
    const tx = db as Tx
    const existing = await tx
      .select({ id: webauthnCredentials.id, name: webauthnCredentials.name })
      .from(webauthnCredentials)
      .where(
        and(eq(webauthnCredentials.id, credentialId), eq(webauthnCredentials.userId, auth.userId))
      )
      .for('update')
      .limit(1)
    const row = existing[0]
    if (!row) throw appError('not_found', 'Hardware key not found.', 404)
    const remaining = (await remainingSecondFactors(tx, auth.userId)) - 1
    const blocked = lastFactorRemovalBlocked({
      orgRole: auth.orgRole ?? 'member',
      remainingAfterDelete: remaining,
    })
    if (blocked.blocked) {
      throw appError('last_second_factor_required', blocked.message, 409)
    }
    await tx.delete(webauthnCredentials).where(eq(webauthnCredentials.id, row.id))
    await writeWebauthnAudit(tx, auth, {
      eventType: AuditEvent.WEBAUTHN_CREDENTIAL_REMOVED,
      resourceId: row.id,
      payload: { credentialId: row.id, name: row.name },
      meta,
    })
    return { id: row.id }
  }
  return tx ? run(tx) : getDb().transaction(run)
}

export { LAST_SECOND_FACTOR_REQUIRED_MESSAGE }
