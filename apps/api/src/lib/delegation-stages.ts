import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { errorCodes } from 'fastify'
import type { FastifyReply, FastifyRequest } from 'fastify'
import {
  DELEGATION_REASON_TO_OUTCOME,
  isPreSignatureRejection,
  verifyDelegationAssertion,
  type DelegationRejectReason,
  type DelegationVerifiedClaims,
} from '../modules/auth/delegation-verify.js'
import { resolveDelegatedActor } from '../modules/auth/delegation-actor.js'
import { recordDelegationOutcome } from '../modules/auth/delegation-metrics.js'
import {
  burnDelegationAssertion,
  DelegationBurnInputError,
  type DelegationBurnOutcome,
} from '../modules/auth/delegation-replay-store.js'
import { writeDelegationSecurityEvent } from '../modules/auth/delegation-security-events.js'
import { resolveOrgByCentralizemeId } from '../modules/service-provisioning/service.js'
import { enforceUserRateLimit } from './route-helpers.js'
import { bindRequestContext } from './request-context.js'

/**
 * Story 71.3 — the PV-owned verification stages of a service-delegated actor assertion (design
 * note `service-delegated-actor-assertion-design.md`, section 4). `buildRouteOptions` installs
 * them from a route's resolved `security.delegation`, never from its handler, so a `wrap`,
 * `replace`, schema merge or hook plan cannot remove them.
 *
 *   S1 `preParsing`  header parse, stateless verification (checks 1-7), per-kid limiter (8),
 *                    `Content-Encoding` rejection. No database access.
 *   S2 `preParsing`  hashes the exact raw body bytes and compares them to `bsh` (9).
 *   S3 `preHandler`  subject binding (10), after schema validation.
 *   S4 `preHandler`  org resolution (11), replay burn (12), actor resolution (13), the delegated
 *                    auth context and `request.delegationContext` (14). Replaces `authenticate`.
 *
 * Why S1 is `preParsing` and not `onRequest` (a deliberate departure from design section 4, which
 * says S1 is an `onRequest` hook): `@fastify/rate-limit` APPENDS its per-IP `onRequest` hook to a
 * route's own `onRequest` array, so an `onRequest` S1 would reject (or accept) a request BEFORE the
 * app-level limiter ever saw it, and an unauthenticated flood would escape that limiter (AC-2b).
 * `preParsing` runs after every `onRequest` hook (including that limiter) and still before the
 * body is read. Session routes have the same relationship: `authenticate` is a `preHandler`.
 *
 * Every later guard (role, route rate limit, capability, the RLS transaction, the handler) is the
 * unchanged `secureRoute` code. Never logs the header, the assertion, the actor subject or the
 * body. Rejections after signature verification are security events (never audit rows).
 */

/** The `userId` of `ctx.auth` for an unlinked actor: a nil UUID that matches no user (R4). */
export const DELEGATION_NIL_USER_ID = ['00000000', '0000', '0000', '0000', '000000000000'].join('-')

/** DW-519 item 1: a request-level bound on the burn (pool saturation must not wait). */
export const DELEGATION_BURN_DEADLINE_MS = 3000

/** Design check 8: per-`kid` budget, spent after a signature verified and before any DB access. */
export const DELEGATION_PRE_BURN_LIMIT = { max: 1200, timeWindowMs: 60_000 } as const

const SCHEME = 'PV-Delegation '
const RETRY_AFTER_SECONDS = 2
const GENERIC_INVALID = { code: 'delegation_invalid', message: 'Delegation assertion is invalid' }

export function delegationKidBucket(kid: string): { userId: string; key: string } {
  return { userId: `delegation-kid:${kid}`, key: 'delegation-pre-burn' }
}

export type DelegationSubjectField = { in: 'body' | 'params'; name: string }

export type NormalizedDelegation = {
  subjectFields: { org?: DelegationSubjectField; actor?: DelegationSubjectField } | undefined
}

/** `true` / `{}` / `{subjectFields}` -> the stage config; `false` / absent -> `false`. */
export function normalizeDelegation(raw: unknown): false | NormalizedDelegation {
  if (raw === undefined || raw === null || raw === false) return false
  if (typeof raw !== 'object' || Array.isArray(raw)) return { subjectFields: undefined }
  const fields: unknown = Reflect.get(raw, 'subjectFields')
  if (typeof fields !== 'object' || fields === null) return { subjectFields: undefined }
  return { subjectFields: fields as NormalizedDelegation['subjectFields'] }
}

/**
 * The 71-4 seam. A linked actor who is no longer a member may, on a route that declares a
 * historical policy and inside the occurrence-time window (`occ`), be admitted on the issuer's
 * attestation. 71-3 ships no historical policy, so nobody is admitted here and a linked
 * non-member is always rejected `delegation_actor_not_member`.
 */
export function resolveHistoricalAdmission(_input: { orgId: string; actorUserId: string }): {
  admitted: false
} {
  return { admitted: false }
}

type RequestState = {
  claims: DelegationVerifiedClaims
  routeKey: string
}

const states = new WeakMap<FastifyRequest, RequestState>()
// Requests a stage already answered: a later stage of the same chain must not answer again while
// Fastify's `reply.sent` may not yet be true (async `onSend` hooks).
const answered = new WeakSet<FastifyRequest>()

type Rejection = {
  status: number
  code: string
  message: string
  outcome: string
  headers?: Record<string, string>
  /** Write a `platform_security_events` row (only for a signature-valid assertion). */
  event: boolean
  kid?: string
  orgId?: string
  jti?: string
}

function requestMeta(request: FastifyRequest) {
  const agent = request.headers['user-agent']
  return { ipAddress: request.ip, userAgent: typeof agent === 'string' ? agent : null }
}

async function reject(
  request: FastifyRequest,
  reply: FastifyReply,
  routeKey: string,
  rejection: Rejection
): Promise<FastifyReply> {
  answered.add(request)
  recordDelegationOutcome(rejection.outcome, rejection.kid)
  if (rejection.event) {
    await writeDelegationSecurityEvent({
      reason: rejection.outcome,
      routeKey,
      status: rejection.status,
      orgId: rejection.orgId,
      kid: rejection.kid,
      jti: rejection.jti,
      meta: requestMeta(request),
    })
  }
  for (const [name, value] of Object.entries(rejection.headers ?? {})) reply.header(name, value)
  reply.status(rejection.status).send({ code: rejection.code, message: rejection.message })
  return reply
}

function rejectGeneric(
  request: FastifyRequest,
  reply: FastifyReply,
  routeKey: string,
  outcome: string
): Promise<FastifyReply> {
  return reject(request, reply, routeKey, {
    status: 401,
    ...GENERIC_INVALID,
    outcome,
    headers: { 'www-authenticate': 'PV-Delegation' },
    event: false,
  })
}

/** R1: the CM-facing public codes follow the signed design note, not the verifier's reasons. */
type PublicResponse = { status: number; code: string; message: string }

const POST_SIGNATURE_RESPONSE_TABLE: Readonly<
  Partial<Record<DelegationRejectReason, PublicResponse>>
> = Object.freeze({
  delegation_malformed_claim: {
    status: 401,
    code: 'delegation_invalid_claims',
    message: 'Delegation assertion claims are invalid',
  },
  delegation_missing_claim: {
    status: 401,
    code: 'delegation_invalid_claims',
    message: 'Delegation assertion claims are invalid',
  },
  delegation_expired: {
    status: 401,
    code: 'delegation_expired',
    message: 'Delegation assertion has expired',
  },
  delegation_clock_skew: {
    status: 401,
    code: 'delegation_not_yet_valid',
    message: 'Delegation assertion is not yet valid',
  },
  delegation_not_yet_valid: {
    status: 401,
    code: 'delegation_not_yet_valid',
    message: 'Delegation assertion is not yet valid',
  },
  delegation_audience_mismatch: {
    status: 421,
    code: 'delegation_wrong_instance',
    message: 'Delegation assertion is for another instance',
  },
})

const POST_SIGNATURE_RESPONSES = new Map<string, PublicResponse>(
  Object.entries(POST_SIGNATURE_RESPONSE_TABLE) as Array<[string, PublicResponse]>
)
const OUTCOME_BY_REASON = new Map<string, string>(Object.entries(DELEGATION_REASON_TO_OUTCOME))

/** The compact JWS of `Authorization: PV-Delegation <jws>`, or undefined (scheme is case sensitive). */
export function parseDelegationHeader(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.startsWith(SCHEME)) return undefined
  const token = value.slice(SCHEME.length)
  return token.length > 0 && !/\s/.test(token) ? token : undefined
}

async function rejectVerification(
  request: FastifyRequest,
  reply: FastifyReply,
  routeKey: string,
  reason: DelegationRejectReason
): Promise<FastifyReply> {
  const outcome = OUTCOME_BY_REASON.get(reason) ?? 'malformed'
  const typed = isPreSignatureRejection(reason) ? undefined : POST_SIGNATURE_RESPONSES.get(reason)
  if (!typed) return rejectGeneric(request, reply, routeKey, outcome)
  return reject(request, reply, routeKey, { ...typed, outcome, event: true })
}

function hasUnsupportedEncoding(request: FastifyRequest): boolean {
  const encoding = request.headers['content-encoding']
  if (encoding === undefined) return false
  return encoding.trim().toLowerCase() !== 'identity'
}

function enforceKidLimit(reply: FastifyReply, kid: string): boolean {
  return enforceUserRateLimit({
    ...delegationKidBucket(kid),
    ...DELEGATION_PRE_BURN_LIMIT,
    reply,
    retryAfterHeader: true,
  })
}

async function afterVerification(
  request: FastifyRequest,
  reply: FastifyReply,
  routeKey: string,
  claims: DelegationVerifiedClaims
): Promise<FastifyReply | undefined> {
  const known = { kid: claims.kid, jti: claims.jti }
  if (claims.operation !== routeKey) {
    return reject(request, reply, routeKey, {
      status: 403,
      code: 'delegation_operation_mismatch',
      message: 'Delegation assertion is for another operation',
      outcome: 'operation_mismatch',
      event: true,
      ...known,
    })
  }
  if (!enforceKidLimit(reply, claims.kid)) {
    answered.add(request)
    recordDelegationOutcome('rate_limited_pre', claims.kid)
    return reply
  }
  if (hasUnsupportedEncoding(request)) {
    return reject(request, reply, routeKey, {
      status: 415,
      code: 'delegation_unsupported_encoding',
      message: 'A delegated request body must not use a Content-Encoding',
      outcome: 'unsupported_encoding',
      event: true,
      ...known,
    })
  }
  return undefined
}

/** S1: header parse + stateless verification (checks 1-7), per-kid limiter (8), encoding. */
export function delegationVerifyStage(routeKey: string) {
  return async (
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<FastifyReply | undefined> => {
    const jws = parseDelegationHeader(request.headers.authorization)
    if (jws === undefined) return rejectGeneric(request, reply, routeKey, 'missing')
    const result = verifyDelegationAssertion(jws)
    if (!result.ok) return rejectVerification(request, reply, routeKey, result.reason)
    const rejected = await afterVerification(request, reply, routeKey, result.claims)
    if (rejected) return rejected
    states.set(request, { claims: result.claims, routeKey })
    return undefined
  }
}

function bodyHashOf(body: Buffer): string {
  return createHash('sha256').update(body).digest('base64url')
}

async function readBounded(payload: NodeJS.ReadableStream, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of payload) {
    const piece = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer)
    total += piece.length
    if (total > limit) {
      ;(payload as Readable).destroy?.()
      throw new errorCodes.FST_ERR_CTP_BODY_TOO_LARGE()
    }
    chunks.push(piece)
  }
  return Buffer.concat(chunks, total)
}

/** A replacement for the consumed request stream; `receivedEncodedLength` keeps Fastify's own
 * content-length validation working on the replayed bytes. */
function replayStream(body: Buffer): Readable {
  const stream = new Readable({
    read() {
      if (body.length > 0) this.push(body)
      this.push(null)
    },
  })
  Object.assign(stream, { receivedEncodedLength: body.length })
  return stream
}

/** S2: hash the exact raw bytes (bounded by the route `bodyLimit`) and compare to `bsh`. */
export function delegationBodyStage(routeKey: string) {
  return async (
    request: FastifyRequest,
    reply: FastifyReply,
    payload: NodeJS.ReadableStream
  ): Promise<NodeJS.ReadableStream | undefined> => {
    if (answered.has(request)) return undefined
    const state = states.get(request)
    if (!state) {
      await rejectGeneric(request, reply, routeKey, 'missing')
      return undefined
    }
    const limit = request.routeOptions.bodyLimit
    const declared = Number(request.headers['content-length'])
    // Fastify's own parser answers 413 for a declared oversize body; do not read it here.
    if (Number.isFinite(declared) && declared > limit) return payload
    const body = await readBounded(payload, limit)
    // Exact string equality on the canonical 43-character base64url form (DW-513 item 4).
    if (bodyHashOf(body) !== state.claims.bodyHash) {
      await reject(request, reply, routeKey, {
        status: 400,
        code: 'delegation_body_mismatch',
        message: 'The request body does not match the delegation assertion',
        outcome: 'body_mismatch',
        event: true,
        kid: state.claims.kid,
        jti: state.claims.jti,
      })
      return undefined
    }
    return replayStream(body)
  }
}

function ownValue(container: unknown, name: string): { present: boolean; value?: unknown } {
  if (typeof container !== 'object' || container === null) return { present: false }
  if (!Object.hasOwn(container, name)) return { present: false }
  return { present: true, value: Reflect.get(container, name) }
}

function fieldDisagrees(
  request: FastifyRequest,
  field: DelegationSubjectField | undefined,
  expected: string
): boolean {
  if (!field) return false
  const found = ownValue(field.in === 'body' ? request.body : request.params, field.name)
  return found.present && found.value !== expected
}

type VerifiedStage = (
  request: FastifyRequest,
  reply: FastifyReply,
  state: RequestState
) => Promise<FastifyReply | undefined>

/**
 * A `preHandler` stage that runs only for a request S1 verified and no earlier stage answered.
 * A request with no state at all means S1 never ran (a PV bug, not a client error): answer the
 * generic 401 instead of reaching the handler.
 */
function afterVerificationStage(routeKey: string, run: VerifiedStage) {
  return async (
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<FastifyReply | undefined> => {
    if (answered.has(request)) return undefined
    const state = states.get(request)
    if (!state) return rejectGeneric(request, reply, routeKey, 'missing')
    return run(request, reply, state)
  }
}

/** S3: a body/path copy of the org or actor that disagrees with the assertion is a sender bug. */
export function delegationSubjectStage(routeKey: string, delegation: NormalizedDelegation) {
  return afterVerificationStage(routeKey, async (request, reply, { claims }) => {
    const fields = delegation.subjectFields
    if (!fields) return undefined
    if (
      fieldDisagrees(request, fields.org, claims.org) ||
      fieldDisagrees(request, fields.actor, claims.actor.subject)
    ) {
      return reject(request, reply, routeKey, {
        status: 400,
        code: 'delegation_subject_mismatch',
        message: 'The request names an organization or actor that the assertion does not',
        outcome: 'subject_mismatch',
        event: true,
        kid: claims.kid,
        jti: claims.jti,
      })
    }
    return undefined
  })
}

/** Resolves once `work` settles, or as `store_unavailable` after the deadline (late commit is safe:
 * the assertion is then simply burned). */
async function burnWithDeadline(
  work: Promise<DelegationBurnOutcome>
): Promise<DelegationBurnOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<DelegationBurnOutcome>((resolve) => {
    timer = setTimeout(
      () => resolve({ outcome: 'store_unavailable', sqlState: null }),
      DELEGATION_BURN_DEADLINE_MS
    )
  })
  try {
    return await Promise.race([work, deadline])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function serviceUnavailable(reply: FastifyReply): FastifyReply {
  reply
    .status(503)
    .send({ code: 'service_unavailable', message: 'Delegation verification is unavailable' })
  return reply
}

function logDelegationError(request: FastifyRequest, eventType: string, err: unknown): void {
  request.log.error({ eventType, err: err instanceof Error ? err.name : 'unknown' })
}

async function resolveOrg(
  request: FastifyRequest,
  reply: FastifyReply,
  routeKey: string,
  claims: DelegationVerifiedClaims
): Promise<string | FastifyReply> {
  let orgId: string | null
  try {
    orgId = await resolveOrgByCentralizemeId(claims.org)
  } catch (err) {
    logDelegationError(request, 'delegation.org_lookup_failed', err)
    return serviceUnavailable(reply)
  }
  if (orgId !== null) return orgId
  return reject(request, reply, routeKey, {
    status: 421,
    code: 'delegation_org_not_served',
    message: 'This instance does not serve the organization of the assertion',
    outcome: 'org_not_served',
    event: true,
    kid: claims.kid,
    jti: claims.jti,
  })
}

async function burn(
  request: FastifyRequest,
  reply: FastifyReply,
  routeKey: string,
  claims: DelegationVerifiedClaims,
  orgId: string
): Promise<FastifyReply | undefined> {
  let outcome: DelegationBurnOutcome
  try {
    outcome = await burnWithDeadline(
      burnDelegationAssertion({
        orgId,
        jti: claims.jti,
        kid: claims.kid,
        assertionExpiresAtSeconds: claims.expiresAt,
      })
    )
  } catch (err) {
    if (err instanceof DelegationBurnInputError) {
      // A contract violation by PV itself, not a client error.
      logDelegationError(request, 'delegation.burn_input_error', err)
      reply.status(500).send({ code: 'internal_error', message: 'Internal server error' })
      return reply
    }
    outcome = { outcome: 'store_unavailable', sqlState: null }
  }
  if (outcome.outcome === 'burned') return undefined
  const known = { kid: claims.kid, jti: claims.jti, orgId, event: true }
  if (outcome.outcome === 'replayed') {
    return reject(request, reply, routeKey, {
      status: 409,
      code: 'delegation_replayed',
      message: 'Delegation assertion was already used',
      outcome: 'replayed',
      ...known,
    })
  }
  return reject(request, reply, routeKey, {
    status: 503,
    code: 'delegation_replay_store_unavailable',
    message: 'Delegation replay store is unavailable',
    outcome: 'store_unavailable',
    headers: { 'retry-after': String(RETRY_AFTER_SECONDS) },
    ...known,
  })
}

type Admission =
  | { reply: FastifyReply }
  | {
      userId: string | null
      orgRole: 'owner' | 'admin' | 'member' | 'viewer' | undefined
      attestation: 'pv_verified' | 'issuer_attested'
    }

async function admitActor(
  request: FastifyRequest,
  reply: FastifyReply,
  routeKey: string,
  claims: DelegationVerifiedClaims,
  orgId: string
): Promise<Admission> {
  let actor: Awaited<ReturnType<typeof resolveDelegatedActor>>
  try {
    actor = await resolveDelegatedActor({
      orgId,
      provider: claims.actor.provider,
      subject: claims.actor.subject,
    })
  } catch (err) {
    logDelegationError(request, 'delegation.actor_lookup_failed', err)
    return { reply: serviceUnavailable(reply) }
  }
  if (actor.kind === 'member') {
    return { userId: actor.userId, orgRole: actor.orgRole, attestation: 'pv_verified' }
  }
  if (actor.kind === 'unlinked') {
    recordDelegationOutcome('actor_unlinked', claims.kid)
    return { userId: null, orgRole: undefined, attestation: 'issuer_attested' }
  }
  if (resolveHistoricalAdmission({ orgId, actorUserId: actor.userId }).admitted) {
    recordDelegationOutcome('actor_attested_nonmember', claims.kid)
    return { userId: actor.userId, orgRole: undefined, attestation: 'issuer_attested' }
  }
  return {
    reply: await reject(request, reply, routeKey, {
      status: 403,
      code: 'delegation_actor_not_member',
      message: 'The actor is not a current member of the organization',
      outcome: 'actor_not_member',
      event: true,
      kid: claims.kid,
      jti: claims.jti,
      orgId,
    }),
  }
}

/** S4: org (11), burn (12), actor (13), then the delegated auth context (14). */
export function delegationResolveStage(routeKey: string) {
  return afterVerificationStage(routeKey, async (request, reply, { claims }) => {
    const orgId = await resolveOrg(request, reply, routeKey, claims)
    if (typeof orgId !== 'string') return orgId
    const burned = await burn(request, reply, routeKey, claims, orgId)
    if (burned) return burned
    const admission = await admitActor(request, reply, routeKey, claims, orgId)
    if ('reply' in admission) return admission.reply
    request.authContext = {
      userId: admission.userId ?? DELEGATION_NIL_USER_ID,
      orgId,
      sessionId: 'delegation',
      jti: claims.jti,
      sessionVersion: 0,
      ...(admission.orgRole === undefined ? {} : { orgRole: admission.orgRole }),
      isPlatformOperator: false,
      delegation: true,
    }
    request.delegationContext = {
      orgId,
      actorId: claims.actor.subject,
      actorProvider: claims.actor.provider,
      actorUserId: admission.userId,
      actorAttestation: admission.attestation,
      delegatedBy: { kid: claims.kid, issuer: claims.issuer },
      assertionId: claims.jti,
      issuedAt: claims.issuedAt,
      operation: routeKey,
    }
    // The ambient org is the RESOLVED one; a user is bound only when the actor is a real user.
    bindRequestContext({ orgId, userId: admission.userId ?? undefined })
    return undefined
  })
}

/**
 * Installs the stages on a `secureRoute`'s route options, before the extension's hook plan is
 * merged (so CM `prepend` hooks run before these stages and `append` hooks after them).
 */
export function installDelegationStages(
  routeOptions: Record<string, unknown>,
  input: { routeKey: string; delegation: NormalizedDelegation }
): void {
  const { routeKey, delegation } = input
  routeOptions['preParsing'] = [delegationVerifyStage(routeKey), delegationBodyStage(routeKey)]
  routeOptions['preHandler'] = [
    delegationSubjectStage(routeKey, delegation),
    delegationResolveStage(routeKey),
  ]
}
