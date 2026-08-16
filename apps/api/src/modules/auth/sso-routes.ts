import { randomBytes, createHmac } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { getDb, withOrg, type Tx } from '@project-vault/db'
import {
  externalIdentities,
  orgMemberships,
  platformSecurityEvents,
  projectInvitations,
  projectMemberships,
  ssoLoginStates,
  userIdentityTokens,
  users,
  type ProjectInvitation,
} from '@project-vault/db/schema'
import { AuditEvent } from '@project-vault/shared'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { AppError } from '../../lib/errors.js'
import { env } from '../../config/env.js'
import { secureRoute } from '../../lib/secure-route.js'
import { getAuditKey } from '../vault/key-service.js'
import { currentAuditKeyVersion } from '../audit/key-version.js'
import { computeAuditHmac } from '../audit/write-entry.js'
import { writeHumanAuditEntry } from '../audit/human-entry.js'
import { firstActorTokenIdForUser } from '../audit/actor-token.js'
import { getAdminDb } from '../../lib/db.js'
import { claimInvitation } from '../invitations/lookup.js'
import { generateUnusablePasswordHash } from './password.js'
import { findAuthStrategy } from './strategies.js'
import { createPendingMfaSession } from './mfa-login.js'
import { createLoginSessionInTx, type LoginResult, type RequestMeta } from './service.js'
import { buildCookieTokens, setAuthCookies, type CookieReply, type JwtSigner } from './tokens.js'
import { markReplacementProven } from './native-login-policy.js'

const STATE_COOKIE_NAME = 'sso-state'
const STATE_TTL_MS = 10 * 60 * 1000
// AC-9 edge case (Pre-mortem finding): bounded wait around onAuthenticate() so a hung/slow/
// unresponsive external IdP call can never tie up the request handler indefinitely.
const AUTHENTICATE_TIMEOUT_MS = 10_000

function generateState(): string {
  return randomBytes(32).toString('base64url')
}

function hashState(raw: string): string {
  return createHmac('sha256', env.SSO_STATE_HMAC_SECRET).update(raw).digest('hex')
}

function metaFromRequest(req: FastifyRequest): RequestMeta {
  return {
    ipAddress: req.ip,
    userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
  }
}

function emailDomain(email: string): string {
  return email.split('@')[1] ?? ''
}

function subjectHash(value: string): string {
  return createHmac('sha256', getAuditKey()).update(value).digest('hex')
}

/**
 * AC-4/AC-7/AC-9 rejection paths that happen before any org is resolvable — no `orgId` exists to
 * scope an `audit_log_entries` row against, so these land in `platform_security_events` instead,
 * mirroring `service.ts`'s `recordLoginFailed()` org-less branch precedent exactly.
 */
async function writePlatformSsoRejected(fields: {
  reason: 'invalid_state' | 'account_link_required' | 'provider_error'
  subject?: string
  meta: RequestMeta
}): Promise<void> {
  try {
    await getDb().transaction(async (tx) => {
      const keyVersion = await currentAuditKeyVersion(tx as Tx)
      const eventType = AuditEvent.SSO_LOGIN_REJECTED
      const payload = { reason: fields.reason }
      const hashedSubject = fields.subject ? subjectHash(fields.subject) : null
      const domain = fields.subject?.includes('@') ? emailDomain(fields.subject) : null
      const hmac = computeAuditHmac(
        {
          eventType,
          subjectHash: hashedSubject,
          emailDomain: domain,
          payload,
          keyVersion,
        },
        getAuditKey()
      )
      await (tx as Tx).insert(platformSecurityEvents).values({
        eventType,
        subjectHash: hashedSubject,
        emailDomain: domain,
        payload,
        keyVersion,
        hmac,
        ipAddress: fields.meta.ipAddress ?? null,
        userAgent: fields.meta.userAgent ?? null,
      })
    })
  } catch (error) {
    process.stderr.write(
      `[sso.login_rejected_audit_error] ${error instanceof Error ? error.message : String(error)}\n`
    )
  }
}

function sendAppError(reply: FastifyReply, error: AppError): unknown {
  return reply.status(error.statusCode).send({ code: error.code, message: error.message })
}

function unknownProviderError(): AppError {
  return new AppError('sso_provider_not_found', 'SSO provider is not configured', 404)
}

async function sendSsoSession(
  fastify: FastifyApp,
  reply: FastifyReply,
  result: LoginResult
): Promise<unknown> {
  setAuthCookies(
    reply as unknown as CookieReply,
    await buildCookieTokens(fastify as unknown as JwtSigner, result.tokens)
  )
  // Story 23.2 AC-4a/AC-5: the proving-latch write, strictly AFTER a session has been issued —
  // this is the one and only call site for every SSO success path (linked-identity and
  // invitation-provisioning both funnel through here). Never touches the frozen in-process
  // policy object (findings N3/N11) and never fails the response (markReplacementProven()
  // swallows its own errors).
  await markReplacementProven()
  return reply.send({
    data: { userId: result.userId, orgId: result.orgId, expiresAt: result.expiresAt },
  })
}

// ---------------------------------------------------------------------------
// AC-3: POST /start/:providerName
// ---------------------------------------------------------------------------

async function handleStart(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const { providerName } = request.params as { providerName: string }
  const entry = findAuthStrategy(providerName)
  if (!entry) return sendAppError(reply, unknownProviderError())

  const raw = generateState()
  const stateHash = hashState(raw)
  await getDb()
    .insert(ssoLoginStates)
    .values({
      stateHash,
      providerName,
      expiresAt: new Date(Date.now() + STATE_TTL_MS),
    })

  ;(reply as unknown as CookieReply).setCookie(STATE_COOKIE_NAME, raw, {
    httpOnly: true,
    // AC-3: deliberately `Lax`, NOT `strict` — this cookie must survive the top-level
    // cross-site redirect back from the IdP, unlike setAuthCookies()'s strict access/refresh
    // cookies. See Dev Notes judgment call #5.
    sameSite: 'lax',
    secure: env.COOKIE_SECURE,
    path: '/',
    maxAge: STATE_TTL_MS / 1000,
  })

  return reply.status(200).send({ data: { state: raw } })
}

// ---------------------------------------------------------------------------
// AC-4: state validation — single shared reject path (uniform work across sub-cases)
// ---------------------------------------------------------------------------

type StateRow = {
  id: string
  stateHash: string
  providerName: string
  expiresAt: Date
  consumedAt: Date | null
}

type StateOutcome =
  | { ok: true }
  | { ok: false; reason: 'missing' | 'expired' | 'consumed' | 'provider_mismatch' | 'not_found' }

/**
 * AC-4: every rejection sub-case (missing/expired/consumed/provider-mismatch/not-found) is
 * classified by this single function, and the caller always performs the same DB lookup +
 * comparable branching work regardless of which sub-case applies — no early-return shortcut
 * exists that could make one branch measurably faster than another. [Security Audit Personas]
 */
function classifyState(row: StateRow | undefined, expectedProvider: string): StateOutcome {
  if (!row) return { ok: false, reason: 'not_found' }
  const now = Date.now()
  const expired = row.expiresAt.getTime() <= now
  const consumed = row.consumedAt !== null
  const providerMismatch = row.providerName !== expectedProvider
  if (expired) return { ok: false, reason: 'expired' }
  if (consumed) return { ok: false, reason: 'consumed' }
  if (providerMismatch) return { ok: false, reason: 'provider_mismatch' }
  return { ok: true }
}

async function consumeState(
  tx: Tx,
  stateHash: string,
  providerName: string
): Promise<StateOutcome> {
  const rows = await tx
    .select()
    .from(ssoLoginStates)
    .where(eq(ssoLoginStates.stateHash, stateHash))
    .for('update')
    .limit(1)
  const outcome = classifyState(rows[0], providerName)
  if (!outcome.ok) return outcome
  await tx
    .update(ssoLoginStates)
    .set({ consumedAt: new Date() })
    .where(eq(ssoLoginStates.id, (rows[0] as StateRow).id))
  return { ok: true }
}

function readStateCookie(request: FastifyRequest): string | undefined {
  const cookies = (request as unknown as { cookies?: Record<string, string> }).cookies
  return cookies?.[STATE_COOKIE_NAME]
}

async function rejectInvalidState(reply: FastifyReply, meta: RequestMeta): Promise<unknown> {
  await writePlatformSsoRejected({ reason: 'invalid_state', meta })
  // AC-4: a single generic error — never distinguishing which sub-case failed (no oracle).
  return sendAppError(
    reply,
    new AppError('invalid_state', 'SSO login could not be verified. Please try again.', 401)
  )
}

// ---------------------------------------------------------------------------
// AC-9: bounded timeout around onAuthenticate()
// ---------------------------------------------------------------------------

class AuthenticateTimeoutError extends Error {}

async function invokeOnAuthenticateWithTimeout(
  strategy: {
    onAuthenticate(credential: string): Promise<{
      externalSubject: string
      providerName: string
      email?: string
      displayName?: string
    }>
  },
  credential: string
) {
  const attempt = strategy.onAuthenticate(credential)
  attempt.catch(() => undefined)
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new AuthenticateTimeoutError('onAuthenticate timed out')),
      AUTHENTICATE_TIMEOUT_MS
    )
  })
  try {
    return await Promise.race([attempt, timeoutPromise])
  } finally {
    clearTimeout(timeoutHandle)
  }
}

// ---------------------------------------------------------------------------
// AC-5/AC-7/AC-8: post-authentication identity resolution + session issuance
// ---------------------------------------------------------------------------

type LinkedIdentityLookup =
  { kind: 'none' } | { kind: 'found'; orgId: string; userId: string } | { kind: 'ambiguous' }

async function findLinkedIdentity(
  providerName: string,
  externalSubject: string
): Promise<LinkedIdentityLookup> {
  // Cross-org point lookup via the admin connection — the org isn't known yet (that's exactly
  // what this query resolves), mirroring findInvitationByTokenHash()'s identical admin-bypass
  // precedent for a pre-auth, org-unknown lookup keyed by a unique index.
  //
  // The unique index on external_identities is (org_id, provider_name, external_subject) — it
  // does NOT prevent the same (providerName, externalSubject) pair from being linked in two
  // different orgs (e.g. two separate admin-linking calls). Fetch all matches rather than
  // limit(1) so that case can be detected and rejected explicitly instead of silently picking
  // an arbitrary org, mirroring the AC-8 multi-org-invitation ambiguity guard.
  const rows = await getAdminDb()
    .select({ orgId: externalIdentities.orgId, userId: externalIdentities.userId })
    .from(externalIdentities)
    .where(
      and(
        eq(externalIdentities.providerName, providerName),
        eq(externalIdentities.externalSubject, externalSubject)
      )
    )
  if (rows.length === 0) return { kind: 'none' }
  const distinctOrgs = new Set(rows.map((row) => row.orgId))
  if (distinctOrgs.size > 1) return { kind: 'ambiguous' }
  const [row] = rows as [{ orgId: string; userId: string }]
  return { kind: 'found', orgId: row.orgId, userId: row.userId }
}

async function findCandidateInvitations(email: string): Promise<ProjectInvitation[]> {
  return getAdminDb()
    .select()
    .from(projectInvitations)
    .where(
      and(
        sql`lower(${projectInvitations.email}) = lower(${email})`,
        isNull(projectInvitations.acceptedAt),
        isNull(projectInvitations.revokedAt),
        sql`${projectInvitations.expiresAt} > now()`
      )
    )
}

async function issueSessionForUser(
  tx: Tx,
  orgId: string,
  userId: string,
  meta: RequestMeta
): Promise<LoginResult> {
  const identityTokenId = await firstActorTokenIdForUser(tx, userId)
  return createLoginSessionInTx(tx, { id: userId, identityTokenId }, orgId, meta)
}

async function findUserMfaEnrolledAndMembership(
  orgId: string,
  userId: string
): Promise<{ mfaEnrolledAt: Date | null; membershipStatus: string | null } | null> {
  const [row] = await withOrg(orgId, (tx) =>
    tx
      .select({
        mfaEnrolledAt: users.mfaEnrolledAt,
        membershipStatus: orgMemberships.status,
      })
      .from(users)
      .innerJoin(
        orgMemberships,
        and(eq(orgMemberships.userId, users.id), eq(orgMemberships.orgId, orgId))
      )
      .where(eq(users.id, userId))
      .limit(1)
  )
  return row ?? null
}

async function handleLinkedSession(
  fastify: FastifyApp,
  reply: FastifyReply,
  linked: { orgId: string; userId: string },
  meta: RequestMeta
): Promise<unknown> {
  try {
    // Mirror loginUser()'s activeMembership gate: a deactivated org member must not be able to
    // retain access via a still-linked external identity just because SSO bypasses the password
    // check. No membership row, or a non-'active' status, is treated the same as "not linked".
    const membership = await findUserMfaEnrolledAndMembership(linked.orgId, linked.userId)
    if (membership?.membershipStatus !== 'active') {
      return rejectAccountLinkRequired(reply, meta)
    }

    // AC-5: SSO-authenticated login follows the IDENTICAL MFA-challenge branch loginUser()
    // already takes — no SSO-specific MFA bypass. Reusing createPendingMfaSession() (rather than
    // re-implementing the challenge logic) is what makes this inheritance real, not assumed.
    if (membership.mfaEnrolledAt) {
      const challenge = await createPendingMfaSession(
        { userId: linked.userId, orgId: linked.orgId },
        meta
      )
      return reply.send({ data: challenge })
    }

    const result = await withOrg(linked.orgId, async (tx) => {
      const session = await issueSessionForUser(tx as Tx, linked.orgId, linked.userId, meta)
      const identityTokenId = await firstActorTokenIdForUser(tx as Tx, linked.userId)
      await writeHumanAuditEntry(tx as Tx, {
        orgId: linked.orgId,
        actorTokenId: identityTokenId,
        eventType: AuditEvent.SSO_LOGIN_SUCCEEDED,
        payload: {},
        meta,
      })
      return session
    })
    return sendSsoSession(fastify, reply, result)
  } catch {
    // AC-6: issueSession fails AFTER state was already consumed — the caller gets a clear,
    // retryable error; the consumed state is never required again (a fresh /start mints a new
    // one immediately). Issuing the session and writing its audit entry in the SAME withOrg
    // transaction (above) ensures this catch can't leave a committed-but-unaudited/orphaned
    // session behind — either both commit, or neither does.
    return sendAppError(reply, new AppError('login_failed', 'Login failed, please try again', 503))
  }
}

async function rejectAccountLinkRequired(reply: FastifyReply, meta: RequestMeta, email?: string) {
  await writePlatformSsoRejected({ reason: 'account_link_required', subject: email, meta })
  return sendAppError(
    reply,
    new AppError(
      'account_link_required',
      'No account is linked to this identity. Ask your organization admin to link your account.',
      403
    )
  )
}

async function handleInvitationProvisioning(
  fastify: FastifyApp,
  reply: FastifyReply,
  invitation: ProjectInvitation,
  authResult: {
    externalSubject: string
    providerName: string
    email?: string
    displayName?: string
  },
  meta: RequestMeta
): Promise<unknown> {
  try {
    const outcome = await withOrg(invitation.orgId, async (tx) => {
      const claimed = await claimInvitation(tx as Tx, invitation.id)
      if (!claimed) return null

      // Story 23.2 AC-6e: a freshly-generated, per-user random, non-functional password hash —
      // NOT the shared env.AUTH_DUMMY_PASSWORD_HASH constant this used to write. See
      // auth/password.ts's generateUnusablePasswordHash() comment for why.
      const [user] = await (tx as Tx)
        .insert(users)
        .values({
          email: (authResult.email as string).toLowerCase(),
          passwordHash: await generateUnusablePasswordHash(),
        })
        .returning({ id: users.id })
      if (!user) throw new Error('handleInvitationProvisioning: user insert returned no row')

      const [identityToken] = await (tx as Tx)
        .insert(userIdentityTokens)
        .values({ userId: user.id, displayName: authResult.email as string })
        .returning({ id: userIdentityTokens.id })
      if (!identityToken) {
        throw new Error('handleInvitationProvisioning: identity token insert returned no row')
      }

      // D5 precedent (service.ts insertRegistrationMemberships): joining via invitation always
      // grants org role 'member'; the invitation's roleToAssign governs the *project* role, not
      // the org role.
      await (tx as Tx)
        .insert(orgMemberships)
        .values({ orgId: invitation.orgId, userId: user.id, role: 'member', status: 'active' })
        .onConflictDoNothing()
      await (tx as Tx)
        .insert(projectMemberships)
        .values({
          orgId: invitation.orgId,
          projectId: invitation.projectId,
          userId: user.id,
          role: invitation.roleToAssign,
        })
        .onConflictDoNothing()

      await (tx as Tx).insert(externalIdentities).values({
        orgId: invitation.orgId,
        userId: user.id,
        providerName: authResult.providerName,
        externalSubject: authResult.externalSubject,
      })

      await writeHumanAuditEntry(tx as Tx, {
        orgId: invitation.orgId,
        actorTokenId: identityToken.id,
        eventType: AuditEvent.PROJECT_INVITATION_ACCEPTED,
        payload: { projectId: invitation.projectId },
        meta,
      })
      await writeHumanAuditEntry(tx as Tx, {
        orgId: invitation.orgId,
        actorTokenId: identityToken.id,
        eventType: AuditEvent.EXTERNAL_IDENTITY_LINKED,
        payload: { providerName: authResult.providerName },
        meta,
      })

      const session = await issueSessionForUser(tx as Tx, invitation.orgId, user.id, meta)
      await writeHumanAuditEntry(tx as Tx, {
        orgId: invitation.orgId,
        actorTokenId: identityToken.id,
        eventType: AuditEvent.SSO_LOGIN_SUCCEEDED,
        payload: {},
        meta,
      })
      return session
    })

    if (!outcome) {
      // AC-8 concurrency edge case: the atomic claim lost the race — the loser retries, never a
      // duplicate users/external_identities row. This is a rejection on a security-relevant path
      // (Task 8: SSO_LOGIN_REJECTED is mandatory on rejection paths, not just success paths).
      await writePlatformSsoRejected({
        reason: 'account_link_required',
        subject: authResult.email,
        meta,
      })
      return sendAppError(
        reply,
        new AppError(
          'invitation_already_claimed',
          'This invitation was just claimed by another request. Please try again.',
          409
        )
      )
    }
    return sendSsoSession(fastify, reply, outcome)
  } catch {
    return sendAppError(reply, new AppError('login_failed', 'Login failed, please try again', 503))
  }
}

async function resolveSessionForAuthResult(
  fastify: FastifyApp,
  reply: FastifyReply,
  authResult: {
    externalSubject: string
    providerName: string
    email?: string
    displayName?: string
  },
  meta: RequestMeta
): Promise<unknown> {
  const linked = await findLinkedIdentity(authResult.providerName, authResult.externalSubject)
  if (linked.kind === 'ambiguous') {
    // The same (providerName, externalSubject) pair is linked in more than one org — mirrors
    // AC-8's multi-org-invitation ambiguity guard: reject rather than silently picking one.
    await writePlatformSsoRejected({
      reason: 'account_link_required',
      subject: authResult.email,
      meta,
    })
    return sendAppError(
      reply,
      new AppError(
        'ambiguous_identity_link',
        'This identity is linked to more than one organization. Contact your organization admin.',
        409
      )
    )
  }
  if (linked.kind === 'found') {
    return handleLinkedSession(fastify, reply, { orgId: linked.orgId, userId: linked.userId }, meta)
  }

  // AC-8 edge case: no email on the AuthResult — invitation-matching is skipped entirely.
  if (!authResult.email) return rejectAccountLinkRequired(reply, meta, authResult.email)

  const invitations = await findCandidateInvitations(authResult.email)
  if (invitations.length === 0) return rejectAccountLinkRequired(reply, meta, authResult.email)
  // AC-8 edge case: the same email has pending invitations in more than one org — reject rather
  // than guessing which org.
  const distinctOrgs = new Set(invitations.map((invitation) => invitation.orgId))
  if (distinctOrgs.size > 1) {
    await writePlatformSsoRejected({
      reason: 'account_link_required',
      subject: authResult.email,
      meta,
    })
    return sendAppError(
      reply,
      new AppError(
        'ambiguous_invitation',
        'Multiple pending invitations match this email. Contact your organization admin.',
        409
      )
    )
  }

  return handleInvitationProvisioning(
    fastify,
    reply,
    invitations[0] as ProjectInvitation,
    authResult,
    meta
  )
}

async function handleProviderError(reply: FastifyReply, meta: RequestMeta): Promise<unknown> {
  await writePlatformSsoRejected({ reason: 'provider_error', meta })
  return sendAppError(
    reply,
    new AppError('sso_provider_error', 'The SSO provider could not be reached', 502)
  )
}

// ---------------------------------------------------------------------------
// AC-4/AC-11: POST /callback/:providerName
// ---------------------------------------------------------------------------

async function handleCallback(
  fastify: FastifyApp,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const { providerName } = request.params as { providerName: string }
  const { credential } = (request.body ?? {}) as { credential?: string }
  const meta = metaFromRequest(request)

  const entry = findAuthStrategy(providerName)
  if (!entry) return sendAppError(reply, unknownProviderError())

  // AC-4: a missing cookie must pay the same DB round trip as expired/consumed/provider-mismatch/
  // not-found so its response latency isn't measurably faster and doesn't become a timing oracle
  // for "was a state cookie ever issued at all." hashState() of an empty string never matches a
  // real stored hash, so this always resolves to the 'not_found' branch via the same query path.
  const rawState = readStateCookie(request)
  const stateHash = hashState(rawState ?? '')
  const outcome = await getDb().transaction((tx) => consumeState(tx as Tx, stateHash, providerName))
  if (!outcome.ok) return rejectInvalidState(reply, meta)

  let authResult: {
    externalSubject: string
    providerName: string
    email?: string
    displayName?: string
  }
  try {
    authResult = await invokeOnAuthenticateWithTimeout(entry.strategy, credential ?? '')
  } catch {
    return handleProviderError(reply, meta)
  }

  return resolveSessionForAuthResult(fastify, reply, authResult, meta)
}

export async function ssoRoutes(fastify: FastifyApp): Promise<void> {
  secureRoute(fastify, {
    method: 'POST',
    url: '/start/:providerName',
    security: {
      requireAuth: false,
      writeAuditEvent: false,
      // Mirrors the /login-adjacent rate-limit convention already used in routes.ts.
      rateLimit: { max: 20, timeWindowMs: 15 * 60 * 1000 },
    },
    handler: async (_ctx, request, reply) => handleStart(request, reply),
  })

  secureRoute(fastify, {
    method: 'POST',
    url: '/callback/:providerName',
    security: {
      requireAuth: false,
      writeAuditEvent: false,
      // Task 5 [Red Team vs Blue Team finding]: independent rate limiting from /start — an
      // unauthenticated callback that (on a valid-looking request) triggers a real outbound
      // onAuthenticate() call is itself a resource-exhaustion target.
      rateLimit: { max: 20, timeWindowMs: 15 * 60 * 1000, key: 'POST /callback' },
    },
    handler: async (_ctx, request, reply) => handleCallback(fastify, request, reply),
  })
}
