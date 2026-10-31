import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { inArray } from 'drizzle-orm'
import { getDb, withOrg, type Tx } from '@project-vault/db'
import { organizations } from '@project-vault/db/schema'
import { HandoffEvent, type HandoffEventType } from '@project-vault/shared'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { env } from '../../config/env.js'
import { secureRoute } from '../../lib/secure-route.js'
import { writeHumanAuditEntry } from '../audit/human-entry.js'
import { firstActorTokenIdForUser } from '../audit/actor-token.js'
import { createPendingMfaSession } from './mfa-login.js'
import type { LoginResult, RequestMeta } from './service.js'
import { buildCookieTokens, setAuthCookies, type CookieReply, type JwtSigner } from './tokens.js'
import {
  verifyHandoffToken,
  type HandoffRejectReason,
  type HandoffVerifiedClaims,
} from './handoff-verify.js'
import { writeHandoffSecurityEvent } from './handoff-security-events.js'
import { hashCookieValue } from '../../lib/opaque-cookie-token.js'
import {
  burnHandoffJti,
  classifyJtiBurnError,
  consumeHandoffNonce,
  insertHandoffNonce,
  type NonceConsumeOutcome,
} from './handoff-nonce-db.js'
import {
  findLinkedIdentity,
  findUserMfaEnrolledAndMembership,
  issueSessionForUser,
} from './sso-routes.js'

/**
 * Story 73.1: the nonce-bound handoff. Two routes replace prepare -> exchange-claim -> confirm:
 *
 * - `POST /start` (called server to server by PV web's `GET /auth/start`) mints a nonce, stores
 *   its HMAC, and returns the issuer URL carrying it. Web puts the raw nonce in a host-only cookie.
 * - `POST /claim` (called server to server by PV web's claim route, which reads that cookie)
 *   consumes the nonce, verifies the token, requires the token's `nonce` claim to equal it, burns
 *   the jti, then mints a session or an MFA challenge.
 *
 * The api never sees the browser cookie: web forwards the cookie's nonce in the body. Every
 * rejection is the same generic 401 plus one `platform_security_events` row naming the reason.
 */

// Claim contract "Clock skew and replay protection": 60 s max token lifetime + 30 s skew before +
// 30 s margin = 120 s. Both the nonce record and the burned jti row use this window.
const HANDOFF_TTL_MS = 120_000

const GENERIC_REJECTION_MESSAGE = 'Sign-in could not be verified. Please start again.'

function metaFromRequest(req: FastifyRequest): RequestMeta {
  return {
    ipAddress: req.ip,
    userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
  }
}

function sendGenericRejection(reply: FastifyReply): unknown {
  return reply.status(401).send({ code: 'handoff_rejected', message: GENERIC_REJECTION_MESSAGE })
}

async function rejectHandoff(
  reply: FastifyReply,
  eventType: HandoffEventType,
  meta: RequestMeta,
  payload?: Record<string, unknown>
): Promise<unknown> {
  await writeHandoffSecurityEvent({ eventType, meta, payload })
  return sendGenericRejection(reply)
}

const REJECT_REASON_TO_EVENT: Record<HandoffRejectReason, HandoffEventType> = {
  handoff_malformed_claim: HandoffEvent.HANDOFF_MALFORMED_CLAIM,
  handoff_claims_oversized: HandoffEvent.HANDOFF_CLAIMS_OVERSIZED,
  handoff_unexpected_alg: HandoffEvent.HANDOFF_UNEXPECTED_ALG,
  handoff_unknown_kid: HandoffEvent.HANDOFF_UNKNOWN_KID,
  handoff_signature_invalid: HandoffEvent.HANDOFF_SIGNATURE_INVALID,
  handoff_missing_claim: HandoffEvent.HANDOFF_MISSING_CLAIM,
  handoff_clock_skew: HandoffEvent.HANDOFF_CLOCK_SKEW,
  handoff_not_yet_valid: HandoffEvent.HANDOFF_NOT_YET_VALID,
  handoff_expired: HandoffEvent.HANDOFF_EXPIRED,
  handoff_audience_mismatch: HandoffEvent.HANDOFF_AUDIENCE_MISMATCH,
  handoff_unknown_assurance: HandoffEvent.HANDOFF_UNKNOWN_ASSURANCE,
}

type OrgResolution =
  { ok: true; orgId: string; userId: string } | { ok: false; eventType: HandoffEventType }

/**
 * AC4.11/AC4.12: the JTI burn happens BEFORE the org cross-check — a token rejected for org
 * mismatch is nonetheless burned and can never be replayed even after "correcting" the org.
 * Split out of `handleClaim` to keep both functions under the repo's complexity threshold.
 */
async function burnAndResolveOrg(claims: HandoffVerifiedClaims): Promise<OrgResolution> {
  try {
    await burnHandoffJti(claims.jti, new Date(Date.now() + HANDOFF_TTL_MS))
  } catch (error) {
    // AC4.11/AC4.13/AC4.14: a unique violation is a replay; any other failure is the replay store
    // being unavailable. Fail closed, never skip the burn.
    return { ok: false, eventType: classifyJtiBurnError(error) }
  }

  // The JTI is already burned above — everything past this point must still fail closed into the
  // single generic-rejection contract (never an unhandled exception reaching Fastify's default
  // error handler) even though the burn's own try/catch no longer covers it.
  try {
    const linked = await findLinkedIdentity(claims.providerName, claims.workosUserId)
    if (linked.kind === 'none') {
      return { ok: false, eventType: HandoffEvent.HANDOFF_ORG_MISMATCH }
    }
    // Design decision: the token's `organizationId` claim is CM's own
    // WorkOS-directory-shaped org identifier (e.g. "org_synthetic_acme") — NEVER PV's own org
    // UUID. It is compared against `organizations.centralizeme_organization_id`, the value PV
    // stores for that org at service-provisioning time (see
    // service-provisioning/service.ts:insertNewProvisioning), never against `linked.orgId`
    // directly. A `null` stored value (org provisioned before this field existed, or via a
    // non-CM path) never matches any claim — fail closed.
    const candidates = linked.kind === 'found' ? [linked] : linked.candidates
    const matches = await filterOrgsByCentralizemeOrgId(candidates, claims.organizationId)
    if (matches.length === 0) {
      return { ok: false, eventType: HandoffEvent.HANDOFF_ORG_MISMATCH }
    }
    if (matches.length > 1) {
      // Defensive only — the partial unique index on centralizeme_organization_id means this
      // should never actually happen.
      return { ok: false, eventType: HandoffEvent.HANDOFF_AMBIGUOUS_ORG }
    }
    const [match] = matches as [{ orgId: string; userId: string }]
    return { ok: true, orgId: match.orgId, userId: match.userId }
  } catch {
    return { ok: false, eventType: HandoffEvent.HANDOFF_REPLAY_STORE_UNAVAILABLE }
  }
}

/**
 * Story 30.2: looks up each candidate org's stored `centralizemeOrganizationId` and returns only
 * the candidates whose stored value matches the token's `organizationId` claim. Used for both the
 * single-candidate ('found') and multi-candidate ('ambiguous') cases so the comparison logic — and
 * its null-never-matches behavior — lives in exactly one place.
 */
async function filterOrgsByCentralizemeOrgId(
  candidates: { orgId: string; userId: string }[],
  claimOrganizationId: string
): Promise<{ orgId: string; userId: string }[]> {
  if (candidates.length === 0) return []
  const orgIds = candidates.map((c) => c.orgId)
  const rows = await getDb()
    .select({
      id: organizations.id,
      centralizemeOrganizationId: organizations.centralizemeOrganizationId,
    })
    .from(organizations)
    .where(inArray(organizations.id, orgIds))
  const matchingOrgIds = new Set(
    rows
      .filter((row) => row.centralizemeOrganizationId === claimOrganizationId)
      .map((row) => row.id)
  )
  return candidates.filter((c) => matchingOrgIds.has(c.orgId))
}

/**
 * AC4.11: the same active-membership and `createPendingMfaSession` branch SSO already uses.
 * Split out of `handleClaim` to keep both functions under the repo's complexity threshold.
 */
async function mintSessionOrMfaChallenge(
  fastify: FastifyApp,
  reply: FastifyReply,
  orgId: string,
  userId: string,
  meta: RequestMeta
): Promise<unknown> {
  const membership = await findUserMfaEnrolledAndMembership(orgId, userId)
  if (membership?.membershipStatus !== 'active') {
    // Unlike the pre-org-resolution rejections (which go through rejectHandoff's org-less
    // platform_security_events write), orgId/userId are already known here — record this as an
    // org-scoped human audit entry (matching HANDOFF_MFA_REQUIRED/HANDOFF_LOGIN_SUCCEEDED below)
    // rather than discarding the known org context into the pre-resolution event table.
    await withOrg(orgId, async (tx) => {
      const identityTokenId = await firstActorTokenIdForUser(tx as Tx, userId)
      await writeHumanAuditEntry(tx as Tx, {
        orgId,
        actorTokenId: identityTokenId,
        eventType: HandoffEvent.HANDOFF_MEMBERSHIP_INACTIVE,
        payload: {},
        meta,
      })
    }).catch(() => undefined)
    return sendGenericRejection(reply)
  }

  if (membership.mfaEnrolledAt) {
    await withOrg(orgId, async (tx) => {
      const identityTokenId = await firstActorTokenIdForUser(tx as Tx, userId)
      await writeHumanAuditEntry(tx as Tx, {
        orgId,
        actorTokenId: identityTokenId,
        eventType: HandoffEvent.HANDOFF_MFA_REQUIRED,
        payload: {},
        meta,
      })
    }).catch(() => undefined)
    const challenge = await createPendingMfaSession({ userId, orgId }, meta)
    return reply.send({ data: challenge })
  }

  const result: LoginResult = await withOrg(orgId, async (tx) => {
    const session = await issueSessionForUser(tx as Tx, orgId, userId, meta)
    const identityTokenId = await firstActorTokenIdForUser(tx as Tx, userId)
    await writeHumanAuditEntry(tx as Tx, {
      orgId,
      actorTokenId: identityTokenId,
      eventType: HandoffEvent.HANDOFF_LOGIN_SUCCEEDED,
      payload: {},
      meta,
    })
    return session
  })

  setAuthCookies(
    reply as unknown as CookieReply,
    await buildCookieTokens(fastify as unknown as JwtSigner, result.tokens)
  )
  return reply.send({
    data: { userId: result.userId, orgId: result.orgId, expiresAt: result.expiresAt },
  })
}

function nonceRejectionEvent(outcome: Exclude<NonceConsumeOutcome, 'consumed'>): HandoffEventType {
  if (outcome === 'unknown') return HandoffEvent.HANDOFF_NONCE_UNKNOWN
  if (outcome === 'reused') return HandoffEvent.HANDOFF_NONCE_REUSED
  return HandoffEvent.HANDOFF_NONCE_EXPIRED
}

// ---------------------------------------------------------------------------
// AC1: POST /auth/handoff/start
// ---------------------------------------------------------------------------

function startRedirectUrl(startUrl: string, nonce: string): string {
  const url = new URL(startUrl)
  url.searchParams.set('nonce', nonce)
  return url.toString()
}

async function handleStart(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  // The enablement toggle gates route behavior, not just the boot-time AuthStrategy marker:
  // routes are registered unconditionally at boot.
  const startUrl = env.VAULT_HANDOFF_START_URL
  if (!env.VAULT_HANDOFF_ENABLED || !startUrl) return sendGenericRejection(reply)

  const nonce = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + HANDOFF_TTL_MS)
  try {
    await insertHandoffNonce(hashCookieValue(nonce), expiresAt)
  } catch {
    return rejectHandoff(
      reply,
      HandoffEvent.HANDOFF_REPLAY_STORE_UNAVAILABLE,
      metaFromRequest(request)
    )
  }

  return reply.status(200).send({
    data: {
      nonce,
      expiresAt: expiresAt.toISOString(),
      redirectUrl: startRedirectUrl(startUrl, nonce),
    },
  })
}

// ---------------------------------------------------------------------------
// AC2-AC4: POST /auth/handoff/claim
// ---------------------------------------------------------------------------

type ClaimCheck =
  { ok: true; claims: HandoffVerifiedClaims } | { ok: false; eventType: HandoffEventType }

/** Compares through the HMACs so the comparison is fixed-length and constant-time. */
function nonceMatches(tokenNonce: string | null, cookieNonceHash: string): boolean {
  if (tokenNonce === null) return false
  return timingSafeEqual(
    Buffer.from(hashCookieValue(tokenNonce), 'hex'),
    Buffer.from(cookieNonceHash, 'hex')
  )
}

/**
 * D5: the nonce is consumed FIRST, whatever happens to the token afterwards, so a failed attempt
 * always needs a new `/auth/start`. Then the token is verified and must carry the same nonce.
 */
async function checkNonceAndToken(nonce: unknown, token: unknown): Promise<ClaimCheck> {
  if (typeof nonce !== 'string' || nonce === '') {
    return { ok: false, eventType: HandoffEvent.HANDOFF_NONCE_MISSING }
  }
  const nonceHash = hashCookieValue(nonce)
  let outcome: NonceConsumeOutcome
  try {
    outcome = await consumeHandoffNonce(nonceHash)
  } catch {
    return { ok: false, eventType: HandoffEvent.HANDOFF_REPLAY_STORE_UNAVAILABLE }
  }
  if (outcome !== 'consumed') return { ok: false, eventType: nonceRejectionEvent(outcome) }

  if (typeof token !== 'string')
    return { ok: false, eventType: HandoffEvent.HANDOFF_MALFORMED_CLAIM }
  const verified = verifyHandoffToken(token)
  if (!verified.ok) return { ok: false, eventType: REJECT_REASON_TO_EVENT[verified.reason] }
  if (!nonceMatches(verified.claims.nonce, nonceHash)) {
    return { ok: false, eventType: HandoffEvent.HANDOFF_NONCE_MISMATCH }
  }
  return { ok: true, claims: verified.claims }
}

/** AC4.17: identity claims still apply on an unknown claims version; it is recorded, not fatal. */
async function recordUnknownClaimsVersion(
  claims: HandoffVerifiedClaims,
  meta: RequestMeta
): Promise<void> {
  if (!claims.unknownClaimsVersion) return
  const payload = { claimsVersion: claims.claimsVersion }
  await writeHandoffSecurityEvent({
    eventType: HandoffEvent.HANDOFF_UNKNOWN_CLAIMS_VERSION,
    meta,
    payload,
  })
  if (claims.capabilities.length > 0 || claims.tier) {
    await writeHandoffSecurityEvent({
      eventType: HandoffEvent.HANDOFF_UNKNOWN_CAPABILITY,
      meta,
      payload,
    })
  }
}

async function handleClaim(
  fastify: FastifyApp,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  if (!env.VAULT_HANDOFF_ENABLED) return sendGenericRejection(reply)

  const meta = metaFromRequest(request)
  const body = (request.body ?? {}) as { token?: unknown; nonce?: unknown }
  const checked = await checkNonceAndToken(body.nonce, body.token)
  if (!checked.ok) return rejectHandoff(reply, checked.eventType, meta)
  await recordUnknownClaimsVersion(checked.claims, meta)

  const resolution = await burnAndResolveOrg(checked.claims)
  if (!resolution.ok) return rejectHandoff(reply, resolution.eventType, meta)

  try {
    return await mintSessionOrMfaChallenge(
      fastify,
      reply,
      resolution.orgId,
      resolution.userId,
      meta
    )
  } catch {
    return reply
      .status(503)
      .send({ code: 'login_failed', message: 'Login failed, please try again' })
  }
}

export function handoffRoutes(fastify: FastifyApp): Promise<void> {
  secureRoute(fastify, {
    method: 'POST',
    url: '/start',
    security: {
      requireAuth: false,
      writeAuditEvent: false,
      rateLimit: { max: 60, timeWindowMs: 60_000, key: 'POST /start' },
    },
    handler: async (_ctx, request, reply) => handleStart(request, reply),
  })

  secureRoute(fastify, {
    method: 'POST',
    url: '/claim',
    bodyLimit: 16 * 1024,
    security: {
      requireAuth: false,
      writeAuditEvent: false,
      rateLimit: { max: 60, timeWindowMs: 60_000, key: 'POST /claim' },
    },
    handler: async (_ctx, request, reply) => handleClaim(fastify, request, reply),
  })
  return Promise.resolve()
}
