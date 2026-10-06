import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { normalizeIP } from '@fastify/rate-limit'
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
import {
  preinitializeDelegationSeries,
  recordDelegationOutcome,
} from '../modules/auth/delegation-metrics.js'
import {
  burnDelegationAssertion,
  DelegationBurnInputError,
  describeStoreFailure,
  type DelegationBurnOutcome,
  type DelegationStoreFailure,
} from '../modules/auth/delegation-replay-store.js'
import { writeDelegationSecurityEvent } from '../modules/auth/delegation-security-events.js'
import { resolveOrgByCentralizemeId } from '../modules/service-provisioning/service.js'
import { consumeUserRateLimit, enforceUserRateLimit } from './route-helpers.js'
import { OCCURRED_AT_UNATTESTED_MAX_PAST_SECONDS, classifyOccurrence } from './occurrence-window.js'
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

/**
 * Story 71.9 (DW-540 item 2): a request-level bound on the security-event write, the same race
 * pattern as the burn deadline. On timeout the typed 4xx is sent without the row; a late insert is
 * harmless (an extra row for a signature-valid rejection, bounded by the per-kid limiter).
 */
export const DELEGATION_EVENT_WRITE_DEADLINE_MS = 2000

/**
 * Story 71.9 AC-4 (DW-539 item 1): the default per-IP budget of a delegated route, spent in the
 * `onRequest` stage before any verification or database work. A constant (no env override): sized
 * high for CentralizeMe's drain, which has to be confirmed with CM 14-17 before release (ledgered
 * in the 71-5 hand-off). Behind a reverse proxy the key is `request.ip`, i.e. the client address
 * Fastify derived from `TRUST_PROXY` / `TRUST_PROXY_HOPS`, never a raw `X-Forwarded-For` header.
 */
export const DELEGATION_IP_RATE_LIMIT = { max: 600, timeWindowMs: 60_000 } as const

/** IPv6 clients share a bucket per /64, IPv4-mapped IPv6 collapses to IPv4 (as `registerIpRateLimit`). */
const IPV6_BUCKET_PREFIX_BITS = 64

export function delegationIpBucket(ip: string): { userId: string; key: string } {
  return {
    userId: `delegation-ip:${normalizeIP(ip, IPV6_BUCKET_PREFIX_BITS)}`,
    key: 'delegation-ip',
  }
}

/** Design check 8: per-`kid` budget, spent after a signature verified and before any DB access. */
export const DELEGATION_PRE_BURN_LIMIT = { max: 1200, timeWindowMs: 60_000 } as const

const SCHEME = 'PV-Delegation '
const RETRY_AFTER_SECONDS = 2
const GENERIC_INVALID = { code: 'delegation_invalid', message: 'Delegation assertion is invalid' }

export function delegationKidBucket(kid: string): { userId: string; key: string } {
  return { userId: `delegation-kid:${kid}`, key: 'delegation-pre-burn' }
}

export type DelegationSubjectField = { in: 'body' | 'params'; name: string }

/** Story 71.4 D5: a route's opt-in to historical actors (an integer 1..30 days, validated at registration). */
export type HistoricalActorPolicy = { maxAgeSeconds: number }

export type NormalizedDelegation = {
  subjectFields: { org?: DelegationSubjectField; actor?: DelegationSubjectField } | undefined
  historicalActorPolicy?: HistoricalActorPolicy
}

/** `true` / `{}` / `{subjectFields}` -> the stage config; `false` / absent -> `false`. */
export function normalizeDelegation(raw: unknown): false | NormalizedDelegation {
  if (raw === undefined || raw === null || raw === false) return false
  if (typeof raw !== 'object' || Array.isArray(raw)) return { subjectFields: undefined }
  const fields: unknown = Reflect.get(raw, 'subjectFields')
  // Own property only (DW-528): an inherited `historicalActorPolicy` must never opt a route in.
  const policy = readHistoricalPolicy(
    Object.hasOwn(raw, 'historicalActorPolicy')
      ? Reflect.get(raw, 'historicalActorPolicy')
      : undefined
  )
  return {
    subjectFields:
      typeof fields === 'object' && fields !== null
        ? (fields as NormalizedDelegation['subjectFields'])
        : undefined,
    ...(policy ? { historicalActorPolicy: policy } : {}),
  }
}

function readHistoricalPolicy(raw: unknown): HistoricalActorPolicy | undefined {
  if (typeof raw !== 'object' || raw === null || !Object.hasOwn(raw, 'maxAgeSeconds')) {
    return undefined
  }
  const maxAge: unknown = Reflect.get(raw, 'maxAgeSeconds')
  return typeof maxAge === 'number' && Number.isInteger(maxAge) && maxAge > 0
    ? { maxAgeSeconds: maxAge }
    : undefined
}

/**
 * Story 71.4 (design Q2): a linked actor who is no longer a current member is admitted on the
 * ISSUER'S attestation, and only on a route that declares a historical policy AND for an assertion
 * that carries a signed `occ`. The occurrence window itself was already enforced statelessly in S1
 * (before the burn), so reaching here with an `occ` means it was inside the route's window. PV keeps
 * no membership history, so this is not a claim that the actor WAS a member then.
 */
export function resolveHistoricalAdmission(input: {
  policy: HistoricalActorPolicy | undefined
  occurredAt: number | undefined
}): { admitted: boolean } {
  return { admitted: input.policy !== undefined && input.occurredAt !== undefined }
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
  /** Closed value for a `store_unavailable` rejection (event payload and log line). */
  storeFailure?: DelegationStoreFailure
}

/** The closed values every `delegation.*` log line may carry besides `requestId`. */
type LogContext = {
  routeKey: string
  outcome: string
  kid?: string
  orgId?: string
  storeFailure?: DelegationStoreFailure
}

/**
 * One structured line per delegation incident: `requestId` (joins the security-event row),
 * `routeKey`, `outcome`, and when known the resolved `orgId` and a CONFIGURED `kid`. Never the
 * header, assertion, actor subject, body or raw `jti`; an error contributes its class name only.
 */
function logDelegation(
  request: FastifyRequest,
  level: 'warn' | 'error',
  eventType: string,
  context: LogContext,
  err?: unknown
): void {
  const fields = {
    eventType,
    requestId: request.id,
    routeKey: context.routeKey,
    outcome: context.outcome,
    ...(context.kid === undefined ? {} : { kid: context.kid }),
    ...(context.orgId === undefined ? {} : { orgId: context.orgId }),
    ...(context.storeFailure === undefined ? {} : { storeFailure: context.storeFailure }),
    ...(err === undefined ? {} : { err: err instanceof Error ? err.name : 'unknown' }),
  }
  if (level === 'warn') request.log.warn(fields, eventType)
  else request.log.error(fields, eventType)
}

function requestMeta(request: FastifyRequest) {
  const agent = request.headers['user-agent']
  return { ipAddress: request.ip, userAgent: typeof agent === 'string' ? agent : null }
}

/**
 * Writes the security event of a signature-valid rejection, best effort and deadline-bound. A
 * suppressed event (the kid is over its limiter budget) writes nothing and logs one line.
 */
async function recordRejectionEvent(
  request: FastifyRequest,
  routeKey: string,
  rejection: Rejection,
  suppressed: boolean
): Promise<void> {
  const context: LogContext = {
    routeKey,
    outcome: rejection.outcome,
    kid: rejection.kid,
    orgId: rejection.orgId,
    storeFailure: rejection.storeFailure,
  }
  if (suppressed) {
    logDelegation(request, 'warn', 'delegation.event_suppressed', context)
    return
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), DELEGATION_EVENT_WRITE_DEADLINE_MS)
  })
  try {
    const settled = await Promise.race([
      writeDelegationSecurityEvent({
        reason: rejection.outcome,
        routeKey,
        status: rejection.status,
        orgId: rejection.orgId,
        kid: rejection.kid,
        jti: rejection.jti,
        requestId: request.id,
        storeFailure: rejection.storeFailure,
        meta: requestMeta(request),
      }).then(() => 'written' as const),
      deadline,
    ])
    if (settled === 'timeout') {
      logDelegation(request, 'warn', 'delegation.security_event_timeout', context)
    }
  } catch (err) {
    logDelegation(request, 'error', 'delegation.security_event_write_error', context, err)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function reject(
  request: FastifyRequest,
  reply: FastifyReply,
  routeKey: string,
  rejection: Rejection,
  options: { suppressEvent?: boolean } = {}
): Promise<FastifyReply> {
  answered.add(request)
  recordDelegationOutcome(rejection.outcome, rejection.kid)
  if (rejection.storeFailure !== undefined) {
    logDelegation(request, 'warn', 'delegation.store_unavailable', {
      routeKey,
      outcome: rejection.outcome,
      kid: rejection.kid,
      orgId: rejection.orgId,
      storeFailure: rejection.storeFailure,
    })
  }
  if (rejection.event) {
    await recordRejectionEvent(request, routeKey, rejection, options.suppressEvent === true)
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

/**
 * A failed verification. Pre-signature reasons collapse into the generic 401 (counter only, no
 * row, no kid). A post-signature reason is typed and writes a security event, but the verifier
 * returned the matched, configured `kid` only because the signature verified, so the per-kid
 * limiter is spent BEFORE the row (DW-540 item 1): over budget the request still gets its typed
 * code and the counter moves, but no row is written.
 */
async function rejectVerification(
  request: FastifyRequest,
  reply: FastifyReply,
  routeKey: string,
  failure: { reason: DelegationRejectReason; kid?: string }
): Promise<FastifyReply> {
  const { reason, kid } = failure
  const outcome = OUTCOME_BY_REASON.get(reason) ?? 'malformed'
  const typed = isPreSignatureRejection(reason) ? undefined : POST_SIGNATURE_RESPONSES.get(reason)
  if (!typed) return rejectGeneric(request, reply, routeKey, outcome)
  const withinBudget = kid !== undefined && consumeUserRateLimit(kidLimit(kid)).allowed
  return reject(
    request,
    reply,
    routeKey,
    { ...typed, outcome, event: true, kid },
    { suppressEvent: !withinBudget }
  )
}

function hasUnsupportedEncoding(request: FastifyRequest): boolean {
  const encoding = request.headers['content-encoding']
  if (encoding === undefined) return false
  return encoding.trim().toLowerCase() !== 'identity'
}

function kidLimit(kid: string) {
  return { ...delegationKidBucket(kid), ...DELEGATION_PRE_BURN_LIMIT }
}

function enforceKidLimit(reply: FastifyReply, kid: string): boolean {
  return enforceUserRateLimit({ ...kidLimit(kid), reply, retryAfterHeader: true })
}

/** The window a route allows for a signed `occ`: its declared policy, else the unattested default. */
function windowSecondsFor(delegation: NormalizedDelegation): number {
  return delegation.historicalActorPolicy?.maxAgeSeconds ?? OCCURRED_AT_UNATTESTED_MAX_PAST_SECONDS
}

async function afterVerification(
  request: FastifyRequest,
  reply: FastifyReply,
  routeKey: string,
  claims: DelegationVerifiedClaims,
  delegation: NormalizedDelegation
): Promise<FastifyReply | undefined> {
  const known = { kid: claims.kid, jti: claims.jti }
  // The per-kid limiter comes first: every rejection below writes a security event (a database
  // write), so a replayed signature-valid assertion must not be able to drive those writes unbounded.
  if (!enforceKidLimit(reply, claims.kid)) {
    answered.add(request)
    recordDelegationOutcome('rate_limited_pre', claims.kid)
    return reply
  }
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
  // Stateless and before the burn and any database access; the per-kid limiter above already bounds
  // the security-event write this rejection makes.
  if (
    claims.occurredAt !== undefined &&
    classifyOccurrence({
      occurredAtMs: claims.occurredAt * 1000,
      nowMs: Date.now(),
      maxAgeSeconds: windowSecondsFor(delegation),
    }) !== 'ok'
  ) {
    return reject(request, reply, routeKey, {
      status: 400,
      code: 'delegation_occurrence_outside_window',
      message: 'The occurrence time of the assertion is outside the window this route accepts',
      outcome: 'occurrence_outside_window',
      event: true,
      ...known,
    })
  }
  return undefined
}

/**
 * S0 `onRequest` (Story 71.9): the per-IP budget. `@fastify/rate-limit` appends its own hook AFTER
 * a route's `onRequest` array and `createApp` registers no app-wide IP limiter, so the delegation
 * stages spend the budget themselves. Over budget: 429 + `Retry-After`, counted as `rate_limited_pre`
 * with no kid, and neither the verifier nor the database is reached.
 */
export function delegationIpLimitStage() {
  return async (
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<FastifyReply | undefined> => {
    const decision = consumeUserRateLimit({
      ...delegationIpBucket(request.ip),
      ...DELEGATION_IP_RATE_LIMIT,
    })
    if (decision.allowed) return undefined
    answered.add(request)
    recordDelegationOutcome('rate_limited_pre')
    reply.header('retry-after', String(decision.retryAfter)).status(429).send({
      code: 'rate_limit_exceeded',
      message: 'Too many requests',
      retryAfter: decision.retryAfter,
    })
    return reply
  }
}

/** S1: header parse + stateless verification (checks 1-7), per-kid limiter (8), encoding. */
export function delegationVerifyStage(routeKey: string, delegation: NormalizedDelegation) {
  return async (
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<FastifyReply | undefined> => {
    const jws = parseDelegationHeader(request.headers.authorization)
    if (jws === undefined) return rejectGeneric(request, reply, routeKey, 'missing')
    const result = verifyDelegationAssertion(jws)
    if (!result.ok) return rejectVerification(request, reply, routeKey, result)
    const rejected = await afterVerification(request, reply, routeKey, result.claims, delegation)
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
    // A declared oversize body is refused here, never passed through unhashed: a method or content
    // type that Fastify does not buffer (GET, a stream parser) would otherwise skip the binding.
    if (Number.isFinite(declared) && declared > limit) {
      ;(payload as Readable).destroy?.()
      throw new errorCodes.FST_ERR_CTP_BODY_TOO_LARGE()
    }
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
      () => resolve({ outcome: 'store_unavailable', sqlState: null, timedOut: true }),
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

const SERVICE_UNAVAILABLE_OUTCOME = 'service_unavailable'

async function resolveOrg(
  request: FastifyRequest,
  reply: FastifyReply,
  routeKey: string,
  claims: DelegationVerifiedClaims
): Promise<string | undefined> {
  let orgId: string | null
  try {
    orgId = await resolveOrgByCentralizemeId(claims.org)
  } catch (err) {
    logDelegation(
      request,
      'error',
      'delegation.org_lookup_failed',
      { routeKey, outcome: SERVICE_UNAVAILABLE_OUTCOME, kid: claims.kid },
      err
    )
    serviceUnavailable(reply)
    return undefined
  }
  if (orgId !== null) return orgId
  await reject(request, reply, routeKey, {
    status: 421,
    code: 'delegation_org_not_served',
    message: 'This instance does not serve the organization of the assertion',
    outcome: 'org_not_served',
    event: true,
    kid: claims.kid,
    jti: claims.jti,
  })
  return undefined
}

/**
 * Burns the assertion. Resolves `true` when the request was ANSWERED (a rejection) and the pipeline
 * must stop; `false` when the assertion is burned and the request continues. It never returns the
 * reply itself: `FastifyReply` is a thenable, so an `async` function that returns one resolves to
 * `undefined` once the response is sent, which made the old caller read "answered" as "continue"
 * and run actor resolution (and count `actor_unlinked`) for an already-answered request.
 */
async function burn(
  request: FastifyRequest,
  reply: FastifyReply,
  routeKey: string,
  claims: DelegationVerifiedClaims,
  orgId: string
): Promise<boolean> {
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
      logDelegation(
        request,
        'error',
        'delegation.burn_input_error',
        { routeKey, outcome: SERVICE_UNAVAILABLE_OUTCOME, kid: claims.kid, orgId },
        err
      )
      reply.status(500).send({ code: 'internal_error', message: 'Internal server error' })
      return true
    }
    outcome = { outcome: 'store_unavailable', sqlState: null }
  }
  if (outcome.outcome === 'burned') return false
  const known = { kid: claims.kid, jti: claims.jti, orgId, event: true }
  await reject(
    request,
    reply,
    routeKey,
    outcome.outcome === 'replayed'
      ? {
          status: 409,
          code: 'delegation_replayed',
          message: 'Delegation assertion was already used',
          outcome: 'replayed',
          ...known,
        }
      : {
          status: 503,
          code: 'delegation_replay_store_unavailable',
          message: 'Delegation replay store is unavailable',
          outcome: 'store_unavailable',
          headers: { 'retry-after': String(RETRY_AFTER_SECONDS) },
          storeFailure: describeStoreFailure(outcome),
          ...known,
        }
  )
  return true
}

type Admission =
  | { reply: FastifyReply }
  | {
      userId: string | null
      orgRole: 'owner' | 'admin' | 'member' | 'viewer' | undefined
      attestation: 'pv_verified' | 'issuer_attested'
      reason: AttestationReason | undefined
    }

type AttestationReason = 'unlinked' | 'not_current_member'

async function admitActor(
  request: FastifyRequest,
  reply: FastifyReply,
  routeKey: string,
  claims: DelegationVerifiedClaims,
  orgId: string,
  delegation: NormalizedDelegation
): Promise<Admission> {
  let actor: Awaited<ReturnType<typeof resolveDelegatedActor>>
  try {
    actor = await resolveDelegatedActor({
      orgId,
      provider: claims.actor.provider,
      subject: claims.actor.subject,
    })
  } catch (err) {
    logDelegation(
      request,
      'error',
      'delegation.actor_lookup_failed',
      { routeKey, outcome: SERVICE_UNAVAILABLE_OUTCOME, kid: claims.kid, orgId },
      err
    )
    return { reply: serviceUnavailable(reply) }
  }
  if (actor.kind === 'member') {
    return {
      userId: actor.userId,
      orgRole: actor.orgRole,
      attestation: 'pv_verified',
      reason: undefined,
    }
  }
  if (actor.kind === 'unlinked') {
    recordDelegationOutcome('actor_unlinked', claims.kid)
    return { userId: null, orgRole: undefined, attestation: 'issuer_attested', reason: 'unlinked' }
  }
  const historical = resolveHistoricalAdmission({
    policy: delegation.historicalActorPolicy,
    occurredAt: claims.occurredAt,
  })
  if (historical.admitted) {
    recordDelegationOutcome('actor_attested_nonmember', claims.kid)
    return {
      userId: actor.userId,
      orgRole: undefined,
      attestation: 'issuer_attested',
      reason: 'not_current_member',
    }
  }
  await reject(request, reply, routeKey, {
    status: 403,
    code: 'delegation_actor_not_member',
    message: 'The actor is not a current member of the organization',
    outcome: 'actor_not_member',
    event: true,
    kid: claims.kid,
    jti: claims.jti,
    orgId,
  })
  return { reply }
}

type AdmittedActor = Exclude<Admission, { reply: FastifyReply }>

/** Step 14: the delegated auth context, `request.delegationContext` and the ambient request context. */
function bindDelegatedRequest(
  request: FastifyRequest,
  input: {
    routeKey: string
    claims: DelegationVerifiedClaims
    orgId: string
    admission: AdmittedActor
  }
): void {
  const { routeKey, claims, orgId, admission } = input
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
    ...(claims.occurredAt === undefined ? {} : { occurredAt: claims.occurredAt }),
    ...(admission.reason === undefined ? {} : { actorAttestationReason: admission.reason }),
  }
  // The ambient org is the RESOLVED one; a user is bound only when the actor is a real user.
  bindRequestContext({
    orgId,
    userId: admission.userId ?? undefined,
    delegation: {
      orgId,
      actor: {
        provider: claims.actor.provider,
        subject: claims.actor.subject,
        userId: admission.userId,
        attestation: admission.attestation,
        reason: admission.reason ?? null,
      },
      delegatedBy: { kid: claims.kid, issuer: claims.issuer, assertionId: claims.jti },
      ...(claims.occurredAt === undefined ? {} : { occurredAtSeconds: claims.occurredAt }),
    },
  })
}

/** S4: org (11), burn (12), actor (13), then the delegated auth context (14). */
export function delegationResolveStage(routeKey: string, delegation: NormalizedDelegation) {
  return afterVerificationStage(routeKey, async (request, reply, { claims }) => {
    const orgId = await resolveOrg(request, reply, routeKey, claims)
    if (orgId === undefined) return reply
    if (await burn(request, reply, routeKey, claims, orgId)) return reply
    const admission = await admitActor(request, reply, routeKey, claims, orgId, delegation)
    if ('reply' in admission) return admission.reply
    bindDelegatedRequest(request, { routeKey, claims, orgId, admission })
    // Admitted by S4 (burn and actor resolution succeeded); NOT "the request succeeded" (71-9 D-e).
    recordDelegationOutcome('accepted', claims.kid)
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
  // Boot: the key set is parsed and a delegated route exists, so every series starts at 0.
  preinitializeDelegationSeries()
  const existingOnRequest = new Map(Object.entries(routeOptions)).get('onRequest')
  routeOptions['onRequest'] = [
    delegationIpLimitStage(),
    ...(existingOnRequest === undefined ? [] : [existingOnRequest].flat()),
  ]
  routeOptions['preParsing'] = [
    delegationVerifyStage(routeKey, delegation),
    delegationBodyStage(routeKey),
  ]
  routeOptions['preHandler'] = [
    delegationSubjectStage(routeKey, delegation),
    delegationResolveStage(routeKey, delegation),
  ]
}
