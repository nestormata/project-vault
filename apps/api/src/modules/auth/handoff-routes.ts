import { randomBytes, createHmac } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { eq } from 'drizzle-orm'
import { getDb, withOrg, type Tx } from '@project-vault/db'
import {
  handoffPendingStates,
  handoffTokenJti,
  organizations,
  users,
} from '@project-vault/db/schema'
import { HandoffEvent, type HandoffEventType } from '@project-vault/shared'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { env } from '../../config/env.js'
import { secureRoute } from '../../lib/secure-route.js'
import { isRejectedBySecFetchSite } from '../../extensions/panel-routes.js'
import { writeHumanAuditEntry } from '../audit/human-entry.js'
import { firstActorTokenIdForUser } from '../audit/actor-token.js'
import { createPendingMfaSession } from './mfa-login.js'
import type { LoginResult, RequestMeta } from './service.js'
import { buildCookieTokens, setAuthCookies, type CookieReply, type JwtSigner } from './tokens.js'
import { verifyHandoffToken, type HandoffRejectReason } from './handoff-verify.js'
import { writeHandoffSecurityEvent } from './handoff-security-events.js'
import {
  findLinkedIdentity,
  findUserMfaEnrolledAndMembership,
  issueSessionForUser,
} from './sso-routes.js'

const HANDOFF_COOKIE_NAME = 'handoff-confirm'
// Claim contract "Clock skew and replay protection": 60s max token lifetime + 30s skew before +
// 30s margin = 120s. Both the pending-state record and the eventual JTI row use this same window.
const PENDING_TTL_MS = 120_000

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

function generateOpaqueId(): string {
  return randomBytes(24).toString('base64url')
}

function hashCookieValue(raw: string): string {
  return createHmac('sha256', env.SSO_STATE_HMAC_SECRET).update(raw).digest('hex')
}

function readHandoffCookie(request: FastifyRequest): string | undefined {
  const cookies = (request as unknown as { cookies?: Record<string, string> }).cookies
  return cookies?.[HANDOFF_COOKIE_NAME]
}

// AC4.16: defense-in-depth CSRF checks — never the primary boundary (that's the same-site
// httpOnly cookie itself plus the one-time pending state). A request missing either header
// entirely is passed through, matching isRejectedBySecFetchSite()'s existing
// old-browser-compatibility convention.
function isRejectedByOriginChecks(request: FastifyRequest): boolean {
  if (isRejectedBySecFetchSite(request.headers['sec-fetch-site'])) return true
  const origin = request.headers['origin']
  const host = request.headers['host']
  if (typeof origin === 'string' && typeof host === 'string') {
    try {
      const originHost = new URL(origin).host
      if (originHost !== host) return true
    } catch {
      return true
    }
  }
  return false
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

// ---------------------------------------------------------------------------
// AC3: POST /auth/handoff/prepare
// ---------------------------------------------------------------------------

async function resolveDisplayNames(
  providerName: string,
  externalSubject: string
): Promise<{ organizationName: string | null; accountLabel: string | null }> {
  try {
    const linked = await findLinkedIdentity(providerName, externalSubject)
    if (linked.kind !== 'found') return { organizationName: null, accountLabel: null }
    const [org] = await getDb()
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, linked.orgId))
      .limit(1)
    const [user] = await withOrg(linked.orgId, (tx) =>
      (tx as Tx)
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, linked.userId))
        .limit(1)
    )
    return { organizationName: org?.name ?? null, accountLabel: user?.email ?? null }
  } catch {
    // Best-effort only — display naming failure must never block the prepare response; the
    // authoritative org/membership check happens again at confirm time.
    return { organizationName: null, accountLabel: null }
  }
}

async function handlePrepare(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const meta = metaFromRequest(request)
  const body = request.body as { token?: unknown } | undefined

  if (!body || typeof body !== 'object' || typeof body.token !== 'string') {
    return rejectHandoff(reply, HandoffEvent.HANDOFF_MALFORMED_CLAIM, meta)
  }

  const result = verifyHandoffToken(body.token)
  if (!result.ok) {
    return rejectHandoff(reply, REJECT_REASON_TO_EVENT[result.reason], meta)
  }
  const { claims } = result
  if (claims.unknownClaimsVersion) {
    await writeHandoffSecurityEvent({
      eventType: HandoffEvent.HANDOFF_UNKNOWN_CLAIMS_VERSION,
      meta,
      payload: { claimsVersion: claims.claimsVersion },
    })
    if (claims.capabilities.length > 0 || claims.tier) {
      await writeHandoffSecurityEvent({
        eventType: HandoffEvent.HANDOFF_UNKNOWN_CAPABILITY,
        meta,
        payload: { claimsVersion: claims.claimsVersion },
      })
    }
  }

  const rawCookie = randomBytes(32).toString('base64url')
  const cookieHash = hashCookieValue(rawCookie)
  const id = generateOpaqueId()
  const expiresAt = new Date(Date.now() + PENDING_TTL_MS)

  try {
    await getDb().insert(handoffPendingStates).values({
      id,
      cookieHash,
      jti: claims.jti,
      providerName: claims.providerName,
      externalSubject: claims.workosUserId,
      organizationId: claims.organizationId,
      claimsVersion: claims.claimsVersion,
      expiresAt,
    })
  } catch {
    return rejectHandoff(reply, HandoffEvent.HANDOFF_REPLAY_STORE_UNAVAILABLE, meta)
  }

  ;(reply as unknown as CookieReply).setCookie(HANDOFF_COOKIE_NAME, rawCookie, {
    httpOnly: true,
    // AC3.7: "SameSite=Lax-or-stricter" — Strict is used here (stricter than sso-state's Lax)
    // since, unlike the SSO callback redirect, the eventual confirm POST is a same-origin
    // submission from PV's own rendered confirmation view, never a cross-site navigation target.
    sameSite: 'strict',
    secure: env.COOKIE_SECURE,
    path: '/',
    maxAge: PENDING_TTL_MS / 1000,
  })

  const { organizationName, accountLabel } = await resolveDisplayNames(
    claims.providerName,
    claims.workosUserId
  )

  return reply.status(200).send({
    data: { pendingId: id, organizationName, accountLabel },
  })
}

// ---------------------------------------------------------------------------
// AC4: POST /auth/handoff/confirm
// ---------------------------------------------------------------------------

type PendingRow = typeof handoffPendingStates.$inferSelect

async function loadPendingState(cookieHash: string): Promise<PendingRow | undefined> {
  const [row] = await getDb()
    .select()
    .from(handoffPendingStates)
    .where(eq(handoffPendingStates.cookieHash, cookieHash))
    .limit(1)
  return row
}

type BurnOutcome =
  { ok: true } | { ok: false; reason: 'handoff_replay' | 'handoff_replay_store_unavailable' }

async function burnJti(jti: string, expiresAt: Date): Promise<BurnOutcome> {
  try {
    await getDb().insert(handoffTokenJti).values({ jti, expiresAt })
    return { ok: true }
  } catch (error) {
    // AC4.11/AC4.13: insert-first burn — a unique-violation on the primary key means the exact
    // jti was already burned (replay). Any OTHER failure (connection refused, pool exhausted,
    // etc.) is treated as the replay store being unavailable — fail closed, never fall back to
    // an in-process Map or skip the burn (AC4.14).
    const code =
      (error as { code?: string; cause?: { code?: string } })?.code ??
      (error as { cause?: { code?: string } })?.cause?.code
    if (code === '23505') return { ok: false, reason: 'handoff_replay' }
    return { ok: false, reason: 'handoff_replay_store_unavailable' }
  }
}

type OrgResolution =
  { ok: true; orgId: string; userId: string } | { ok: false; eventType: HandoffEventType }

/**
 * AC4.11/AC4.12: the JTI burn happens BEFORE the org cross-check — a token rejected for org
 * mismatch is nonetheless burned and can never be replayed even after "correcting" the org.
 * Split out of `handleConfirm` to keep both functions under the repo's complexity threshold.
 */
async function burnAndResolveOrg(pending: PendingRow): Promise<OrgResolution> {
  const burn = await burnJti(pending.jti, pending.expiresAt)
  if (!burn.ok) {
    return {
      ok: false,
      eventType:
        burn.reason === 'handoff_replay'
          ? HandoffEvent.HANDOFF_REPLAY
          : HandoffEvent.HANDOFF_REPLAY_STORE_UNAVAILABLE,
    }
  }

  const linked = await findLinkedIdentity(pending.providerName, pending.externalSubject)
  if (linked.kind === 'ambiguous') {
    return { ok: false, eventType: HandoffEvent.HANDOFF_AMBIGUOUS_ORG }
  }
  if (linked.kind === 'none') {
    return { ok: false, eventType: HandoffEvent.HANDOFF_ORG_MISMATCH }
  }
  // Design decision (documented — see Dev Notes): the token's `organizationId` claim is CM's
  // reference to the PV organization, and this codebase has no separate CM-org-id mapping table,
  // so it is compared directly against PV's own org UUID.
  if (linked.orgId !== pending.organizationId) {
    return { ok: false, eventType: HandoffEvent.HANDOFF_ORG_MISMATCH }
  }
  return { ok: true, orgId: linked.orgId, userId: linked.userId }
}

/**
 * AC4.11: the same active-membership and `createPendingMfaSession` branch SSO already uses.
 * Split out of `handleConfirm` to keep both functions under the repo's complexity threshold.
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
    return rejectHandoff(reply, HandoffEvent.HANDOFF_MEMBERSHIP_INACTIVE, meta)
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

async function handleConfirm(
  fastify: FastifyApp,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const meta = metaFromRequest(request)

  // AC4.16: defense-in-depth only — never the primary CSRF boundary.
  if (isRejectedByOriginChecks(request)) {
    return rejectHandoff(reply, HandoffEvent.HANDOFF_MALFORMED_CLAIM, meta)
  }

  const rawCookie = readHandoffCookie(request)
  if (!rawCookie) return rejectHandoff(reply, HandoffEvent.HANDOFF_REPLAY, meta)
  const cookieHash = hashCookieValue(rawCookie)

  const pending = await loadPendingState(cookieHash)
  // AC4.15: a missing/expired pending state is rejected the same generic way as an already-burned
  // JTI — internally distinguishable (this branch vs. the burn's unique-violation branch), never
  // surfaced differently to the caller.
  if (!pending || pending.expiresAt.getTime() <= Date.now()) {
    return rejectHandoff(reply, HandoffEvent.HANDOFF_REPLAY, meta)
  }

  const resolution = await burnAndResolveOrg(pending)
  if (!resolution.ok) {
    return rejectHandoff(reply, resolution.eventType, meta)
  }

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

export async function handoffRoutes(fastify: FastifyApp): Promise<void> {
  secureRoute(fastify, {
    method: 'POST',
    url: '/prepare',
    bodyLimit: 16 * 1024,
    security: {
      requireAuth: false,
      writeAuditEvent: false,
      // AC7: the existing public-route default — do not omit rateLimit (would silently disable
      // it) and do not set a custom, undocumented limit.
      rateLimit: { max: 60, timeWindowMs: 60_000 },
    },
    handler: async (_ctx, request, reply) => handlePrepare(request, reply),
  })

  secureRoute(fastify, {
    method: 'POST',
    url: '/confirm',
    security: {
      requireAuth: false,
      writeAuditEvent: false,
      rateLimit: { max: 60, timeWindowMs: 60_000, key: 'POST /confirm' },
    },
    handler: async (_ctx, request, reply) => handleConfirm(fastify, request, reply),
  })
}
