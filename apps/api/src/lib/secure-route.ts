import type { FastifyReply, FastifyRequest, FastifySchema, preHandlerHookHandler } from 'fastify'
import { getDb, type Tx } from '@project-vault/db'
import { auditLogEntries } from '@project-vault/db/schema'
import { requireMfaEnrollment } from '../modules/auth/mfa-enforcement.js'
import { firstActorTokenIdForUser } from '../modules/audit/actor-token.js'
import { currentAuditKeyVersion } from '../modules/audit/key-version.js'
import { computeAuditHmac } from '../modules/audit/write-entry.js'
import { getAuditKey } from '../modules/vault/key-service.js'
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
  audit: {
    eventType?: string
    resourceType?: string
    resourceId?: string
    payload?: Record<string, unknown>
  }
}

export type PublicRouteContext = Record<string, never>

export type SecureRouteRegistrationOptions = {
  method: HttpMethod
  url: string
  schema?: FastifySchema
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
  ) => Promise<unknown> | unknown
}

class AuditWriteError extends Error {}

export class SameTransactionAuditWriteError extends Error {
  constructor(message: string) {
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
  return Boolean((reply as unknown as { sent?: boolean }).sent)
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

function logRouteError(request: FastifyRequest, payload: Record<string, unknown>): void {
  ;(request as unknown as { log?: { error?: (payload: unknown) => void } }).log?.error?.(payload)
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
  const fields = {
    orgId: auth.orgId,
    actorTokenId,
    actorType: 'human',
    eventType: config.eventType,
    resourceId,
    resourceType: config.resourceType,
    payload,
    keyVersion,
  }
  const hmac = computeAuditHmac(fields, getAuditKey())
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
  })
}

type ResolvedSecurity = {
  requireAuth: boolean
  requireOrgScope: boolean
  rateLimit: false | { max: number; timeWindowMs?: number; key?: string }
}

type RequestPhase = 'rls' | 'handler' | 'audit'

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
    rateLimit:
      security.rateLimit === undefined ? { max: 60, timeWindowMs: 60_000 } : security.rateLimit,
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
  return enforceMfaIfRequired(options, request, reply)
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
    return options.handler({ auth } as unknown as SecureRouteContext, request, reply)
  }

  const db = (options.db ?? getDb()) as TransactionalDb
  return db.transaction(async (tx) => {
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
        throw new AuditWriteError(error instanceof Error ? error.message : String(error))
      }
    }
    return handlerResult
  })
}

function sendSecureRouteFailure(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
  phase: RequestPhase
): unknown {
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
    const result = await runProtectedHandler({
      auth,
      options,
      requireOrgScope: resolvedSecurity.requireOrgScope,
      request,
      reply,
      auditWriter: options.auditWriter ?? defaultAuditWriter,
      state,
    })
    return sendIfNeeded(reply, result)
  } catch (error) {
    return sendSecureRouteFailure(request, reply, error, state.phase)
  }
}

export function buildSecurePreHandlers(
  fastify: { authenticate?: unknown },
  options: SecureRouteOptions
): preHandlerHookHandler[] {
  const chain: preHandlerHookHandler[] = []
  if (options.requireAuth !== false) {
    if (typeof fastify.authenticate !== 'function') {
      throw new Error(
        'buildSecurePreHandlers: requireAuth is set but fastify.authenticate is not registered'
      )
    }
    chain.push(fastify.authenticate as preHandlerHookHandler)
  }
  if (options.requireOrgRole?.length) chain.push(requireOrgRole(...options.requireOrgRole))
  if (options.requireMfa) chain.push(requireMfaEnrollment())
  return chain
}

function assertSecureRouteConfig(
  fastify: RouteFastify,
  options: SecureRouteRegistrationOptions,
  resolvedSecurity: ResolvedSecurity
): void {
  if (resolvedSecurity.requireAuth && typeof fastify.authenticate !== 'function') {
    throw new Error('SecureRoute: requireAuth is true but fastify.authenticate is not registered')
  }
  if (options.security?.allowedRoles && options.security.allowedRoles.length === 0) {
    throw new Error('SecureRoute: allowedRoles must not be empty')
  }
  if (!resolvedSecurity.requireOrgScope && auditConfigFor(options)) {
    throw new Error('SecureRoute: writeAuditEvent requires requireOrgScope')
  }
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
    attachValidation: Boolean(options.schema?.body),
    preHandler,
    handler: (request: FastifyRequest, reply: FastifyReply) =>
      handleSecureRouteRequest({ options, resolvedSecurity, request, reply }),
  }

  const routeHost = fastify.withTypeProvider ? fastify.withTypeProvider() : fastify
  routeHost.route(routeOptions as never)
  secureRoutes.add(`${options.method} ${options.url}`)
}
