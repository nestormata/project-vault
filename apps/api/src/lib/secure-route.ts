import type { FastifyReply, FastifyRequest, FastifySchema, preHandlerHookHandler } from 'fastify'
import { getDb, type Tx } from '@project-vault/db'
import { auditLogEntries } from '@project-vault/db/schema'
import { CapabilityId, type CapabilityIdValue } from '@project-vault/shared'
import { checkCapability, getCapabilityGate } from './capability-gate.js'
import { recordCapabilityDeniedAudit } from './capability-gate-audit.js'
import { requireMfaEnrollment } from '../modules/auth/mfa-enforcement.js'
import { firstActorTokenIdForUser } from '../modules/audit/actor-token.js'
import { currentAuditKeyVersion } from '../modules/audit/key-version.js'
import {
  computeAuditHmac,
  getPreviousEntryHmac,
  GENESIS_SENTINEL,
} from '../modules/audit/write-entry.js'
import {
  assertOrgMayWriteAuditGates,
  estimateAuditEntrySizeBytes,
  recordAuditQuotaRefusalBestEffort,
  recordAuditRateRefusalBestEffort,
} from '../modules/audit/quota-gate.js'
import { getAuditKey } from '../modules/vault/key-service.js'
import { env } from '../config/env.js'
import { requireOrgRole, type OrgRole } from '../plugins/require-org-role.js'
import { enforceUserRateLimit } from './route-helpers.js'
import { setRlsOrgContext } from '../middleware/rls.js'

export const secureRoutes = new Set<string>()

export type SecureRouteOptions = {
  requireAuth?: boolean
  requireMfa?: boolean
  requireOrgRole?: OrgRole[]
}

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
type AuthContext = NonNullable<FastifyRequest['authContext']>
type TransactionalDb = {
  transaction: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>
}
type RouteFastify = {
  authenticate?: unknown
  route: (options: never) => unknown
  withTypeProvider?: <_T>() => { route: (options: never) => unknown }
}

export type AuditConfig = {
  eventType: string
  resourceType?: string
  resourceIdFromParams?: string
  payload?: (input: {
    params: Record<string, unknown>
    query: Record<string, unknown>
  }) => Record<string, unknown>
}

export type SecureRouteContext = {
  auth: AuthContext
  tx: Tx
  onPostCommit: (callback: PostCommitCallback) => void
  audit: {
    eventType?: string
    resourceType?: string
    resourceId?: string
    payload?: Record<string, unknown>
  }
}

export type PostCommitCallback = () => void | Promise<void>

export type PublicRouteContext = Record<string, never>

export type SecureRouteRegistrationOptions = {
  method: HttpMethod
  url: string
  schema?: FastifySchema
  // Story 14.4 AC-9: matches routes.ts's raw fastify.route() `bodyLimit: 4096` convention for
  // public, unauthenticated request-body-accepting routes — forwarded straight through to
  // fastify's own route registration (fastify's global default otherwise applies).
  bodyLimit?: number
  security?: {
    requireAuth?: boolean
    requireOrgScope?: boolean
    minimumRole?: OrgRole
    allowedRoles?: OrgRole[]
    requireMfa?: boolean
    writeAuditEvent?: boolean | AuditConfig
    rateLimit?: false | { max: number; timeWindowMs?: number; key?: string }
    // Story 9.1 D1: an explicit, named opt-out from org-role authorization in favor of the
    // instance-wide `users.is_platform_operator` flag — used by backup/restore routes, which pair
    // this with `requireOrgScope: false` (architecture.md's "concerns opted out explicitly with
    // named flags" principle). Mutually exclusive in practice with minimumRole/allowedRoles: when
    // set, org-role checks are skipped entirely (org role has no meaning for a whole-instance
    // operation) and only the platform-operator check applies.
    requirePlatformOperator?: boolean
    // Story 23.3 AC-10/AC-14/AC-23: declarative capability-gate check. Unset behaves exactly as
    // today — zero code path change (AC-5). This is the ONLY field secureRoute() gains for this
    // story; growing the gated surface additionally requires editing the golden route inventory
    // (apps/api/src/__tests__/gated-route-inventory.test.ts).
    capability?: CapabilityIdValue
  }
  db?: TransactionalDb
  auditWriter?: (input: {
    tx: Tx
    auth: AuthContext
    request: FastifyRequest
    config: AuditConfig
  }) => Promise<void>
  handler: (
    ctx: SecureRouteContext | PublicRouteContext,
    req: FastifyRequest,
    reply: FastifyReply
  ) => unknown
}

class AuditWriteError extends Error {}

// Story 22.1 AC-9/AC-19: `code` distinguishes the three ways this rethrow can now happen —
// `audit_quota_exhausted` (a per-org quota refusal), `audit_gate_unavailable` (the gate
// statement itself errored, fail-closed), or undefined (the pre-existing generic
// `audit_write_failed` case, unrelated to quota). Kept on the existing error class rather than a
// new one so every other `rethrowAsSameTransactionAuditWriteError` call site is unaffected.
export class SameTransactionAuditWriteError extends Error {
  constructor(
    message: string,
    public readonly code?: 'audit_quota_exhausted' | 'audit_gate_unavailable' | 'audit_rate_limited'
  ) {
    super(message)
    this.name = 'SameTransactionAuditWriteError'
  }
}

// Exported so Story 9.4's platform-audit write path (modules/platform-audit/write-entry.ts) can
// reuse the exact same forbidden-key set/matching logic rather than duplicating it.
export const FORBIDDEN_AUDIT_KEYS = new Set([
  'password',
  'passphrase',
  'masterKeyPath',
  'envelopeKeyPath',
  'secret',
  'value',
  'authorization',
  'cookie',
  'accessToken',
  'refreshToken',
  'totp',
  'recoveryCode',
  'apiKey',
])
const MUTATING_METHODS = new Set<HttpMethod>(['POST', 'PUT', 'PATCH', 'DELETE'])

function isReplySent(reply: FastifyReply): boolean {
  return reply.sent
}

function sendIfNeeded(reply: FastifyReply, result: unknown): unknown {
  if (isReplySent(reply) || result === reply) return result
  return reply.send(result)
}

function sendMissingAuth(reply: FastifyReply): unknown {
  return reply
    .status(401)
    .send({ code: 'access_token_missing', message: 'Access token is missing' })
}

function sendInsufficientRole(reply: FastifyReply): unknown {
  return reply.status(403).send({
    code: 'insufficient_role',
    message: 'Insufficient permissions',
  })
}

// Story 9.1 D1/AC-1: distinct 403 code from insufficient_role — this is an instance-wide
// authorization axis, not an org-role check, and the two must never be conflated in a client
// error-handling branch.
function sendPlatformOperatorRequired(reply: FastifyReply): unknown {
  return reply.status(403).send({
    code: 'platform_operator_required',
    message: 'This endpoint requires platform operator privileges.',
  })
}

// Story 23.3 AC-21: distinct 403 code from both insufficient_role and platform_operator_required
// — a separate authorization axis, never conflated with PV's own role/MFA authorization.
function sendCapabilityDenied(
  reply: FastifyReply,
  capability: string,
  decision: { reasonCode: string; message?: string }
): unknown {
  return reply.status(403).send({
    code: 'capability_denied',
    capability,
    reasonCode: decision.reasonCode,
    message: decision.message,
  })
}

function logRouteError(request: FastifyRequest, payload: Record<string, unknown>): void {
  ;(request as unknown as { log?: { error?: (payload: unknown) => void } }).log?.error?.(payload)
}

function logPostCommitCallbackFailure(request: FastifyRequest, error: unknown): void {
  try {
    ;(
      request as unknown as {
        log?: { warn?: (payload: unknown, message: string) => void }
      }
    ).log?.warn?.(
      { eventType: 'secure_route.post_commit_callback_failed', err: error },
      'SecureRoute post-commit callback failed'
    )
  } catch {
    // Post-commit logging is best-effort too; a broken logger must not change a committed result.
  }
}

async function runPostCommitCallback(callback: PostCommitCallback): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.resolve().then(callback),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('SecureRoute post-commit callback timed out')),
          10_000
        )
      }),
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

async function runPostCommitCallbacks(
  request: FastifyRequest,
  callbacks: PostCommitCallback[]
): Promise<void> {
  for (const callback of callbacks.splice(0)) {
    try {
      await runPostCommitCallback(callback)
    } catch (error) {
      logPostCommitCallbackFailure(request, error)
    }
  }
}

function normalizeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

// Exported (Story 9.4) so the platform-audit write path can reuse the exact same forbidden-key
// matching/sanitization logic rather than duplicating it.
export function isForbiddenAuditKey(key: string): boolean {
  const normalized = key.toLowerCase()
  return [...FORBIDDEN_AUDIT_KEYS].some((forbidden) => normalized.includes(forbidden.toLowerCase()))
}

function sanitizeAuditValue(value: unknown, seen: WeakSet<object>): unknown {
  if (Array.isArray(value)) return value.map((entry) => sanitizeAuditValue(entry, seen))
  if (!value || typeof value !== 'object') return value
  if (seen.has(value)) return '[Circular]'
  seen.add(value)
  return sanitizeAuditPayload(value as Record<string, unknown>, seen)
}

export function sanitizeAuditPayload(
  value: Record<string, unknown>,
  seen = new WeakSet<object>()
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !isForbiddenAuditKey(key))
      .map(([key, entry]) => [key, sanitizeAuditValue(entry, seen)])
  )
}

function stringValueForKey(record: Record<string, unknown>, key: string): string | undefined {
  const entry = Object.entries(record).find(([candidate]) => candidate === key)
  return typeof entry?.[1] === 'string' ? entry[1] : undefined
}

function auditConfigFor(options: SecureRouteRegistrationOptions): AuditConfig | null {
  const configured = options.security?.writeAuditEvent
  if (configured === false) return null
  if (configured === true) return { eventType: `${options.method} ${options.url}` }
  if (configured === undefined && MUTATING_METHODS.has(options.method)) {
    return { eventType: `${options.method} ${options.url}` }
  }
  return configured ?? null
}

export function roleRank(role: OrgRole): number {
  switch (role) {
    case 'owner':
      return 3
    case 'admin':
      return 2
    case 'member':
      return 1
    case 'viewer':
      return 0
  }
}

function hasSufficientRole(auth: AuthContext, options: SecureRouteRegistrationOptions): boolean {
  const allowedRoles = options.security?.allowedRoles
  if (allowedRoles?.length) return allowedRoles.includes(auth.orgRole)
  const minimumRole = options.security?.minimumRole ?? 'viewer'
  return roleRank(auth.orgRole) >= roleRank(minimumRole)
}

async function defaultAuditWriter({
  tx,
  auth,
  request,
  config,
}: {
  tx: Tx
  auth: AuthContext
  request: FastifyRequest
  config: AuditConfig
}): Promise<void> {
  const params = normalizeRecord(request.params)
  const query = normalizeRecord(request.query)
  const payload = sanitizeAuditPayload(config.payload?.({ params, query }) ?? {})
  const resourceId = config.resourceIdFromParams
    ? stringValueForKey(params, config.resourceIdFromParams)
    : undefined
  if (config.resourceIdFromParams && !resourceId) {
    throw new Error(`SecureRoute: missing audit resourceId param "${config.resourceIdFromParams}"`)
  }
  const actorTokenId = await firstActorTokenIdForUser(tx, auth.userId)
  const keyVersion = await currentAuditKeyVersion(tx)
  const previousHmac = await getPreviousEntryHmac(tx, {
    table: 'audit_log_entries',
    orgId: auth.orgId,
  })
  const fields = {
    orgId: auth.orgId,
    actorTokenId,
    actorType: 'human',
    eventType: config.eventType,
    resourceId,
    resourceType: config.resourceType,
    payload,
    keyVersion,
    previousEntryHmac: previousHmac ?? GENESIS_SENTINEL,
  }
  const hmac = computeAuditHmac(fields, getAuditKey())
  // Story 22.1 AC-13 / 22.2 AC-4 (site 4 of 9 — the inline defaultAuditWriter insert). Rate gate
  // runs first, then the storage gate, inside assertOrgMayWriteAuditGates — the documented
  // ordering decision (a rate-refused request never has its size estimated/attributed to the
  // storage counter).
  await assertOrgMayWriteAuditGates(tx, {
    orgId: auth.orgId,
    eventType: config.eventType,
    sizeBytes: estimateAuditEntrySizeBytes({
      payload,
      resourceId,
      resourceType: config.resourceType,
    }),
  })
  await tx.insert(auditLogEntries).values({
    orgId: auth.orgId,
    actorTokenId,
    actorType: 'human',
    eventType: config.eventType,
    resourceId,
    resourceType: config.resourceType,
    ipAddress: request.ip,
    userAgent:
      typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
    payload,
    keyVersion,
    hmac,
    previousEntryHmac: previousHmac,
  })
}

type ResolvedSecurity = {
  requireAuth: boolean
  requireOrgScope: boolean
  rateLimit: false | { max: number; timeWindowMs?: number; key?: string }
}

type RequestPhase = 'rls' | 'handler' | 'audit'

type TransactionOutcome = {
  result: unknown
  postCommitCallbacks: PostCommitCallback[]
}

function withAuditSendGuard(reply: FastifyReply, enabled: boolean): () => void {
  if (!enabled) return () => undefined
  const guarded = reply as FastifyReply & { send: FastifyReply['send'] }
  const originalSend = guarded.send
  guarded.send = ((..._args: Parameters<FastifyReply['send']>) => {
    throw new Error('SecureRoute: audited handlers must return data instead of sending replies')
  }) as FastifyReply['send']
  return () => {
    guarded.send = originalSend
  }
}

function resolveSecurity(options: SecureRouteRegistrationOptions): ResolvedSecurity {
  const security = options.security ?? {}
  const requireAuth = security.requireAuth !== false
  return {
    requireAuth,
    requireOrgScope: security.requireOrgScope !== false && requireAuth,
    rateLimit: security.rateLimit ?? { max: 60, timeWindowMs: 60_000 },
  }
}

async function handlePublicRequest(
  options: SecureRouteRegistrationOptions,
  rateLimit: ResolvedSecurity['rateLimit'],
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  if (
    rateLimit &&
    !enforceUserRateLimit({
      userId: `ip:${request.ip}`,
      key: rateLimit.key ?? `${options.method} ${options.url}`,
      max: rateLimit.max,
      timeWindowMs: rateLimit.timeWindowMs,
      reply,
    })
  ) {
    return reply
  }
  const result = await options.handler({}, request, reply)
  return sendIfNeeded(reply, result)
}

async function enforceMfaIfRequired(
  options: SecureRouteRegistrationOptions,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<boolean> {
  if (!options.security?.requireMfa) return true
  await requireMfaEnrollment()(request, reply)
  return !isReplySent(reply)
}

function enforceRouteRateLimit(
  options: SecureRouteRegistrationOptions,
  rateLimit: ResolvedSecurity['rateLimit'],
  auth: AuthContext,
  reply: FastifyReply
): boolean {
  if (!rateLimit) return true
  return enforceUserRateLimit({
    userId: auth.userId,
    key: rateLimit.key ?? `${options.method} ${options.url}`,
    max: rateLimit.max,
    timeWindowMs: rateLimit.timeWindowMs,
    reply,
  })
}

async function enforceProtectedGuards({
  auth,
  options,
  rateLimit,
  request,
  reply,
}: {
  auth: AuthContext
  options: SecureRouteRegistrationOptions
  rateLimit: ResolvedSecurity['rateLimit']
  request: FastifyRequest
  reply: FastifyReply
}): Promise<boolean> {
  if (options.security?.requirePlatformOperator) {
    if (!auth.isPlatformOperator) {
      sendPlatformOperatorRequired(reply)
      return false
    }
  } else if (!hasSufficientRole(auth, options)) {
    sendInsufficientRole(reply)
    return false
  }
  if (!enforceRouteRateLimit(options, rateLimit, auth, reply)) return false
  if (!(await enforceMfaIfRequired(options, request, reply))) return false
  return enforceCapabilityIfRequired(options, auth, request, reply)
}

// Story 23.3 AC-10 — a per-request marker (log-only double-check backstop), keyed off the
// FastifyRequest instance itself so it never outlives the request and never becomes a decision
// cache.
const perRequestCheckedCapabilities = new WeakMap<FastifyRequest, Set<string>>()

function perRequestSeenSetFor(request: FastifyRequest): Set<string> {
  const existing = perRequestCheckedCapabilities.get(request)
  if (existing) return existing
  const fresh = new Set<string>()
  perRequestCheckedCapabilities.set(request, fresh)
  return fresh
}

// Story 23.3 AC-25 — write (dampened) capability.denied audit row for an authenticated,
// org-scoped denial. Never routed through sendSecureRouteFailure's audit_write_failed 503 path: a
// denial is a completed authorization outcome, not a partially-applied mutation, so an audit
// hiccup must not turn a completed 403 into a less-restrictive-looking 503. Failure is logged and
// swallowed.
async function auditCapabilityDenialBestEffort(
  request: FastifyRequest,
  auth: AuthContext,
  capability: string,
  reasonCode: string
): Promise<void> {
  try {
    await recordCapabilityDeniedAudit({
      orgId: auth.orgId,
      userId: auth.userId,
      capability,
      reasonCode,
    })
  } catch (error) {
    logRouteError(request, { eventType: 'secure_route.capability_denied_audit_failed', err: error })
  }
}

// Story 23.3 AC-10/AC-19/AC-20/AC-23/AC-25 — the declarative capability-gate step, added as one
// new, explicitly-named step inside enforceProtectedGuards(), strictly AFTER MFA enforcement and
// BEFORE runProtectedHandler() opens the transaction, so a slow/hung gate holds no pooled
// connection. Routes with `security.capability` unset make ZERO gate calls (AC-5/AC-20 spy
// assertion). With NO gate registered, checkCapability() is never invoked at all — AC-5's
// byte-identical-to-today guarantee for the overwhelmingly common no-extension case.
async function enforceCapabilityIfRequired(
  options: SecureRouteRegistrationOptions,
  auth: AuthContext,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<boolean> {
  const capability = options.security?.capability
  if (!capability) return true
  const gate = getCapabilityGate()
  if (!gate) return true
  const decision = await checkCapability(gate, {
    capability,
    orgId: auth.orgId,
    userId: auth.userId,
    orgRole: auth.orgRole,
    surface: 'org',
    requestId: request.id,
    logger: request.log,
    perRequestSeen: perRequestSeenSetFor(request),
  })
  if (decision.permitted) return true
  await auditCapabilityDenialBestEffort(request, auth, capability, decision.reasonCode)
  sendCapabilityDenied(reply, capability, decision)
  return false
}

async function runProtectedHandler({
  auth,
  options,
  requireOrgScope,
  request,
  reply,
  auditWriter,
  state,
}: {
  auth: AuthContext
  options: SecureRouteRegistrationOptions
  requireOrgScope: boolean
  request: FastifyRequest
  reply: FastifyReply
  auditWriter: NonNullable<SecureRouteRegistrationOptions['auditWriter']>
  state: { phase: RequestPhase }
}): Promise<unknown> {
  const auditConfig = auditConfigFor(options)
  if (!requireOrgScope) {
    return {
      result: await options.handler(
        { auth, onPostCommit: () => undefined } as unknown as SecureRouteContext,
        request,
        reply
      ),
      postCommitCallbacks: [],
    }
  }

  const db = (options.db ?? getDb()) as TransactionalDb
  const postCommitCallbacks: PostCommitCallback[] = []
  const result = await db.transaction(async (tx) => {
    const typedTx = tx as Tx
    state.phase = 'rls'
    await setRlsOrgContext(tx as { execute: (query: unknown) => Promise<unknown> }, auth.orgId)
    state.phase = 'handler'
    const restoreReplySend = withAuditSendGuard(reply, Boolean(auditConfig))
    let handlerResult: unknown
    try {
      handlerResult = await options.handler(
        {
          auth,
          tx: typedTx,
          onPostCommit: (callback) => {
            postCommitCallbacks.push(callback)
          },
          audit: auditConfig
            ? { eventType: auditConfig.eventType, resourceType: auditConfig.resourceType }
            : {},
        },
        request,
        reply
      )
    } finally {
      restoreReplySend()
    }
    if (auditConfig) {
      state.phase = 'audit'
      try {
        await auditWriter({ tx: typedTx, auth, request, config: auditConfig })
      } catch (error) {
        // Story 22.1 AC-9/AC-19 fix: a SameTransactionAuditWriteError (thrown by
        // assertOrgMayWriteAuditGates inside defaultAuditWriter, or by a custom auditWriter)
        // already carries the `code` sendSecureRouteFailure needs to distinguish
        // `audit_quota_exhausted`/`audit_rate_limited` and `audit_gate_unavailable` from a
        // generic audit-write failure. Re-wrapping it here in a fresh AuditWriteError discarded
        // that code and silently downgraded every refusal to the generic `audit_write_failed`
        // 503 — rethrow it unchanged instead.
        if (error instanceof SameTransactionAuditWriteError) {
          throw error
        }
        throw new AuditWriteError(error instanceof Error ? error.message : String(error))
      }
    }
    return handlerResult
  })
  return { result, postCommitCallbacks }
}

// Story 22.1 AC-9/AC-26: a per-org quota refusal, not a generic audit-write failure — the message
// names no other organization, no instance-wide figure, and no absolute capacity number.
// recordAuditQuotaRefusalBestEffort was implemented but never wired in anywhere before this fix —
// refused_write_count/last_refusal_at on audit_org_storage_usage silently never incremented. This
// is the one and only call site the function's own docstring describes ("only ever called from
// the 503 error path... after the refusing transaction has rolled back"). Best-effort: it
// swallows and logs its own failure internally. Split out of sendSecureRouteFailure to keep that
// function's cyclomatic complexity under the lint threshold.
async function sendAuditQuotaExhaustedFailure(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
  orgId?: string
): Promise<unknown> {
  logRouteError(request, { eventType: 'secure_route.audit_quota_exhausted', err: error })
  if (orgId) {
    await recordAuditQuotaRefusalBestEffort(orgId)
  }
  return reply.status(503).send({
    code: 'audit_quota_exhausted',
    message: 'Audit storage quota exhausted for this organization',
  })
}

// Story 22.2 AC-7/AC-9: a per-org rate refusal, distinct 429 from the storage gate's 503. The
// Retry-After value is computed AFTER rollback, via recordAuditRateRefusalBestEffort's best-effort
// follow-up read (never carried on the exception itself, keeping the hot refusal path a single
// statement). Falls back to the configured window length (rounded up, seconds) if the best-effort
// read fails or returns no row — never omits the header or guesses a smaller number.
async function sendAuditRateLimitedFailure(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
  orgId?: string
): Promise<unknown> {
  logRouteError(request, { eventType: 'secure_route.audit_rate_limited', err: error })
  let retryAfterSeconds: number | undefined
  if (orgId) {
    const result = await recordAuditRateRefusalBestEffort(orgId)
    retryAfterSeconds = result?.retryAfterSeconds
  }
  retryAfterSeconds ??= Math.ceil(env.AUDIT_ORG_WRITE_RATE_WINDOW_MS / 1000)
  reply.header('Retry-After', String(retryAfterSeconds))
  return reply.status(429).send({
    code: 'audit_rate_limited',
    message: 'Audit write rate limit exceeded for this organization',
  })
}

// Story 22.2: split out of sendSecureRouteFailure to keep that function's cyclomatic complexity
// under the lint threshold — dispatches the three SameTransactionAuditWriteError codes to their
// own response, or returns `undefined` (not itself a valid response) when `error` isn't one of
// these three, letting the caller fall through to its generic audit-failure handling.
async function sendGatedAuditWriteFailure(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
  orgId?: string
): Promise<unknown> {
  if (!(error instanceof SameTransactionAuditWriteError)) return undefined
  if (error.code === 'audit_quota_exhausted') {
    return sendAuditQuotaExhaustedFailure(request, reply, error, orgId)
  }
  if (error.code === 'audit_rate_limited') {
    return sendAuditRateLimitedFailure(request, reply, error, orgId)
  }
  if (error.code === 'audit_gate_unavailable') {
    // Story 22.1 AC-19: the gate statement itself errored — fail closed, never a silent allow.
    logRouteError(request, { eventType: 'secure_route.audit_gate_unavailable', err: error })
    return reply.status(503).send({
      code: 'audit_gate_unavailable',
      message: 'Audit quota gate is unavailable',
    })
  }
  return undefined
}

async function sendSecureRouteFailure(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
  phase: RequestPhase,
  orgId?: string
): Promise<unknown> {
  if (isReplySent(reply)) {
    throw new Error('SecureRoute: handler sent a response before audit completed')
  }
  if (phase === 'rls') {
    logRouteError(request, { eventType: 'secure_route.rls_context_failed', err: error })
    return reply.status(503).send({
      code: 'service_unavailable',
      message: 'Database security context unavailable',
    })
  }
  const gatedFailure = await sendGatedAuditWriteFailure(request, reply, error, orgId)
  if (gatedFailure !== undefined) return gatedFailure
  if (
    error instanceof AuditWriteError ||
    error instanceof SameTransactionAuditWriteError ||
    phase === 'audit'
  ) {
    logRouteError(request, { eventType: 'secure_route.audit_write_failed', err: error })
    return reply.status(503).send({
      code: 'audit_write_failed',
      message: 'Audit logging is unavailable',
    })
  }
  throw error
}

async function handleSecureRouteRequest({
  options,
  resolvedSecurity,
  request,
  reply,
}: {
  options: SecureRouteRegistrationOptions
  resolvedSecurity: ResolvedSecurity
  request: FastifyRequest
  reply: FastifyReply
}): Promise<unknown> {
  if (isReplySent(reply)) return reply
  if (!resolvedSecurity.requireAuth) {
    return handlePublicRequest(options, resolvedSecurity.rateLimit, request, reply)
  }

  const auth = request.authContext
  if (!auth) return sendMissingAuth(reply)
  const guardsPassed = await enforceProtectedGuards({
    auth,
    options,
    rateLimit: resolvedSecurity.rateLimit,
    request,
    reply,
  })
  if (!guardsPassed) return reply

  const state: { phase: RequestPhase } = { phase: 'handler' }
  try {
    const outcome = (await runProtectedHandler({
      auth,
      options,
      requireOrgScope: resolvedSecurity.requireOrgScope,
      request,
      reply,
      auditWriter: options.auditWriter ?? defaultAuditWriter,
      state,
    })) as TransactionOutcome
    await runPostCommitCallbacks(request, outcome.postCommitCallbacks)
    return sendIfNeeded(reply, outcome.result)
  } catch (error) {
    return await sendSecureRouteFailure(request, reply, error, state.phase, auth.orgId)
  }
}

export function buildSecurePreHandlers(
  fastify: { authenticate?: unknown },
  options: SecureRouteOptions
): preHandlerHookHandler[] {
  const chain: preHandlerHookHandler[] = []
  if (options.requireAuth !== false) {
    if (typeof fastify.authenticate !== 'function') {
      throw new TypeError(
        'buildSecurePreHandlers: requireAuth is set but fastify.authenticate is not registered'
      )
    }
    chain.push(fastify.authenticate as preHandlerHookHandler)
  }
  if (options.requireOrgRole?.length) chain.push(requireOrgRole(...options.requireOrgRole))
  if (options.requireMfa) chain.push(requireMfaEnrollment())
  return chain
}

// Story 23.3 AC-22: boot-time (primary) validation — an unknown capability id is a startup
// failure, the cheapest possible place to catch an id typo'd or refactored away (which would
// otherwise silently stop being gated, with no log and no failing test).
function assertKnownCapabilityId(options: SecureRouteRegistrationOptions): void {
  const capability = options.security?.capability
  if (capability !== undefined && !(Object.values(CapabilityId) as string[]).includes(capability)) {
    throw new Error(`SecureRoute: unknown capability id "${capability}"`)
  }
}

function assertSecureRouteConfig(
  fastify: RouteFastify,
  options: SecureRouteRegistrationOptions,
  resolvedSecurity: ResolvedSecurity
): void {
  if (resolvedSecurity.requireAuth && typeof fastify.authenticate !== 'function') {
    throw new Error('SecureRoute: requireAuth is true but fastify.authenticate is not registered')
  }
  if (options.security?.allowedRoles?.length === 0) {
    throw new Error('SecureRoute: allowedRoles must not be empty')
  }
  if (!resolvedSecurity.requireOrgScope && auditConfigFor(options)) {
    throw new Error('SecureRoute: writeAuditEvent requires requireOrgScope')
  }
  assertKnownCapabilityId(options)
}

export function secureRoute(fastify: RouteFastify, options: SecureRouteRegistrationOptions): void {
  const resolvedSecurity = resolveSecurity(options)
  assertSecureRouteConfig(fastify, options, resolvedSecurity)

  const preHandler: preHandlerHookHandler[] = []
  if (resolvedSecurity.requireAuth) preHandler.push(fastify.authenticate as preHandlerHookHandler)

  const routeOptions = {
    method: options.method,
    url: options.url,
    schema: options.schema,
    ...(options.bodyLimit !== undefined ? { bodyLimit: options.bodyLimit } : {}),
    attachValidation: Boolean(options.schema?.body),
    preHandler,
    handler: (request: FastifyRequest, reply: FastifyReply) =>
      handleSecureRouteRequest({ options, resolvedSecurity, request, reply }),
  }

  const routeHost = fastify.withTypeProvider ? fastify.withTypeProvider() : fastify
  routeHost.route(routeOptions as never)
  secureRoutes.add(`${options.method} ${options.url}`)
}
