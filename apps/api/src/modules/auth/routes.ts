import type { FastifyReply } from 'fastify/types/reply.js'
import type { FastifyRequest } from 'fastify/types/request.js'
import rateLimit from '@fastify/rate-limit'
import { z } from 'zod/v4'
import { eq, sql } from 'drizzle-orm'
import { getDb } from '@project-vault/db'
import { organizations } from '@project-vault/db/schema'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { AppError } from '../../lib/errors.js'
import { env } from '../../config/env.js'
import { ApiErrorSchema, withRouteTypeProvider } from '../../lib/api-contracts.js'
import { isRateLimitEnforced, validationError } from '../../lib/route-helpers.js'
import {
  secureRoute,
  SameTransactionAuditWriteError,
  type SecureRouteContext,
} from '../../lib/secure-route.js'
import { sendNotificationJobs, type NotificationQueueJob } from '../../notifications/dispatcher.js'
import type { BossService } from '../../lib/boss.js'
import {
  LoginRequestSchema,
  RegisterRequestSchema,
  authMeResponseSchema,
  mfaEnrollResponseSchema,
  mfaRegenerateBodySchema,
  mfaRegenerateResponseSchema,
  mfaVerifyLoginBodySchema,
  mfaVerifyLoginResponseSchema,
  mfaRecoverBodySchema,
  mfaRecoverResponseSchema,
  mfaVerifyEnrollmentBodySchema,
  mfaVerifyEnrollmentResponseSchema,
  registerRouteResponseSchema,
  loginResponseSchema,
  refreshResponseSchema,
  sessionsListResponseSchema,
  revokeOtherSessionsResponseSchema,
  methodNotAllowedResponseSchema,
} from './schema.js'
import { normalizeEmail } from './normalize.js'
import { clearAuthCookies, setAuthCookies, type CookieReply } from './tokens.js'
import {
  enrollMfa,
  getMfaStatus,
  recoverWithCode,
  regenerateRecoveryCodes,
  verifyEnrollment,
} from './mfa.js'
import { verifyLogin, type MfaChallengeResult } from './mfa-login.js'
import {
  listSessions,
  loginUser,
  refreshSession,
  registerUser,
  type TokenMaterial,
} from './service.js'
import { loadMfaEnforcementStatus } from './mfa-enforcement.js'
import { revokeAllOtherSessions, revokeSessionById, sessionNotFound } from './session-revoke.js'
import {
  RateLimitExceededResponseSchema,
  RecoveryCompleteBodySchema,
  RecoveryCompleteResponseSchema,
  RecoveryMfaStartResponseSchema,
  RecoveryNoAdminResponseSchema,
  RecoveryPeekResponseSchema,
  RecoveryRequestBodySchema,
  RecoveryRequestResponseSchema,
  RecoveryTokenParamsSchema,
  type RecoveryTokenParams,
} from './recovery-schema.js'
import {
  completeAccountRecovery,
  peekRecoveryToken,
  requestSelfRecovery,
  startRecoveryMfa,
} from './recovery.js'

type JwtFastify = FastifyApp & {
  jwt: {
    sign: (
      payload: Record<string, unknown>,
      options: { jti: string; expiresIn: number }
    ) => Promise<string> | string
    decode: (token: string) => unknown
  }
}
type BossFastify = FastifyApp & { boss?: BossService }

/**
 * pg-boss is decorated on the fastify instance in production (main.ts) but not in
 * integration tests that build the app directly — jobs are still enqueued in
 * notification_queue either way, only the async delivery dispatch is skipped.
 *
 * Never let a dispatch failure propagate: for regenerate-recovery-codes this call
 * happens inside the ambient secureRoute transaction (pre-commit — see Dev Agent
 * Record), so an uncaught throw here would roll back the already-successful MFA
 * operation. For recover-with-code the operation has already committed, so an
 * uncaught throw would return a 500 to a user whose recovery code was already
 * consumed and session already created. Either way, a missed boss.send() is safe —
 * the notification_queue row is still durable and notification/deliver-catchup
 * (10-min cron, main.ts) will pick it up.
 */
async function sendPendingMfaNotifications(
  fastify: FastifyApp,
  jobs: NotificationQueueJob[]
): Promise<void> {
  const boss = (fastify as BossFastify).boss
  if (!boss) return
  try {
    await sendNotificationJobs(boss, jobs)
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        eventType: 'auth.mfa_notification_dispatch_failed',
        error: error instanceof Error ? error.message : String(error),
        jobCount: jobs.length,
      })}\n`
    )
  }
}
type ParsedBody<T> = { success: true; data: T } | { success: false; reply: FastifyReply }
type AuthSessionResult = {
  userId: string
  orgId: string
  expiresAt: string
  tokens: TokenMaterial
}

function isMfaChallengeResult(
  result: AuthSessionResult | MfaChallengeResult
): result is MfaChallengeResult {
  return 'mfaRequired' in result
}

function asciiEmailValidationError() {
  return {
    code: 'validation_error',
    message: 'Request validation failed',
    details: { email: ['ASCII characters only'] },
  }
}

function bodyWithNormalizedEmail(body: unknown): unknown {
  if (!body || typeof body !== 'object' || !('email' in body)) return body
  return {
    ...(body as Record<string, unknown>),
    email: normalizeEmail(String((body as { email: unknown }).email)),
  }
}

function normalizeEmailBodyForRoute(
  body: unknown,
  reply: FastifyReply
): { success: true; body: unknown } | { success: false; reply: FastifyReply } {
  try {
    return { success: true, body: bodyWithNormalizedEmail(body) }
  } catch (error) {
    if (error instanceof AppError && error.code === 'validation_error') {
      return { success: false, reply: reply.status(422).send(asciiEmailValidationError()) }
    }
    throw error
  }
}

function metaFromRequest(req: FastifyRequest) {
  return {
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'] ?? null,
  }
}

async function buildCookieTokens(fastify: FastifyApp, tokens: TokenMaterial) {
  const jwt = await (fastify as JwtFastify).jwt.sign(
    {
      sub: tokens.accessClaims.sub,
      orgId: tokens.accessClaims.orgId,
      sessionVersion: tokens.accessClaims.sessionVersion,
    },
    { jti: tokens.accessClaims.jti, expiresIn: tokens.accessMaxAgeSec }
  )
  return { ...tokens, accessJwt: jwt }
}

function parseBody<T>(
  schema: z.ZodType<T>,
  req: FastifyRequest,
  reply: FastifyReply
): ParsedBody<T> {
  const parsed = schema.safeParse(req.body)
  if (!parsed.success)
    return { success: false, reply: reply.status(422).send(validationError(parsed.error, 'body')) }
  return { success: true, data: parsed.data }
}

async function sendAuthSession(
  fastify: FastifyApp,
  reply: FastifyReply,
  result: AuthSessionResult,
  extraData: Record<string, unknown> = {}
) {
  clearAuthCookies(reply as unknown as CookieReply)
  setAuthCookies(reply as unknown as CookieReply, await buildCookieTokens(fastify, result.tokens))
  return reply.send({
    data: {
      userId: result.userId,
      orgId: result.orgId,
      expiresAt: result.expiresAt,
      ...extraData,
    },
  })
}

/** Shared by the three token-scoped recovery routes (peek, mfa/start, complete). */
function parseRecoveryTokenParams(
  req: FastifyRequest,
  reply: FastifyReply
): RecoveryTokenParams | null {
  const parsed = RecoveryTokenParamsSchema.safeParse(req.params)
  if (!parsed.success) {
    reply.status(422).send(validationError(parsed.error, 'params'))
    return null
  }
  return parsed.data
}

/** Shared status-error shape all three recovery-lookup results (recovery.ts) resolve to. */
function sendRecoveryStatusError(
  reply: FastifyReply,
  error: { statusCode: number; code: string; message: string }
): unknown {
  return reply.status(error.statusCode).send({ code: error.code, message: error.message })
}

/**
 * Shared IP-rate-limit + email-normalization prefix for /mfa/recover and /recovery/request —
 * both public, both keyed by `ip:${req.ip}` via the same DB-backed bucket (AC-11). Returns the
 * normalized body for the caller's own schema-specific parse, or null once a reply was already
 * sent (rate-limited or malformed email).
 */
async function enforceIpRateLimitAndNormalizeEmailBody(
  req: FastifyRequest,
  reply: FastifyReply
): Promise<unknown | null> {
  if (!(await enforceRecoverRateLimit(`ip:${req.ip}`, 10, reply))) return null
  const normalized = normalizeEmailBodyForRoute(req.body, reply)
  return normalized.success ? normalized.body : null
}

/**
 * Shared schema-parse + email-rate-limit tail for /mfa/recover and /recovery/request — both
 * validate their (differently-shaped) body, then apply the same per-email DB-backed bucket
 * (AC-11) keyed off whatever `email` field the parsed body carries.
 */
async function parseBodyAndEnforceEmailRateLimit<T extends { email: string }>(
  schema: z.ZodType<T>,
  normalizedBody: unknown,
  reply: FastifyReply
): Promise<T | null> {
  const parsed = schema.safeParse(normalizedBody)
  if (!parsed.success) {
    reply.status(422).send(validationError(parsed.error, 'body'))
    return null
  }
  if (!(await enforceRecoverRateLimit(`email:${parsed.data.email}`, 5, reply))) return null
  return parsed.data
}

async function sendMfaAction<T>(
  reply: FastifyReply,
  action: () => Promise<T>
): Promise<{ data: T } | { code: string; message: string }> {
  try {
    return { data: await action() }
  } catch (error) {
    if (error instanceof AppError) {
      reply.status(error.statusCode)
      return { code: error.code, message: error.message }
    }
    throw error
  }
}

function accessTokenExpFromRequest(fastify: FastifyApp, req: FastifyRequest): Date | undefined {
  const accessToken = (req as unknown as { cookies?: Record<string, string | undefined> })
    .cookies?.['access-token']
  if (!accessToken) return undefined
  const decoded = (fastify as JwtFastify).jwt.decode(accessToken)
  if (!decoded || typeof decoded !== 'object') return undefined
  const exp = (decoded as { exp?: unknown }).exp
  return typeof exp === 'number' ? new Date(exp * 1000) : undefined
}

function sendAppError(reply: FastifyReply, error: AppError) {
  return reply.status(error.statusCode).send({ code: error.code, message: error.message })
}

/**
 * AC-16: recovery request/completion self-manage their own transaction (org context isn't known
 * before token/email resolution — see recovery.ts), so a failed-closed audit write surfaces as a
 * thrown SameTransactionAuditWriteError instead of SecureRoute's own audit-phase handling. Mirror
 * SecureRoute's 503 audit_write_failed contract here.
 */
function sendRecoveryFailure(reply: FastifyReply, error: unknown): unknown {
  if (error instanceof SameTransactionAuditWriteError) {
    return reply
      .status(503)
      .send({ code: 'audit_write_failed', message: 'Audit logging is unavailable' })
  }
  if (error instanceof AppError) return sendAppError(reply, error)
  throw error
}

async function enforceRecoverRateLimit(
  key: string,
  max: number,
  reply: FastifyReply,
  timeWindowMs = 15 * 60 * 1000
): Promise<boolean> {
  const now = new Date()
  const resetAt = new Date(now.getTime() + timeWindowMs)
  const nowIso = now.toISOString()
  const resetAtIso = resetAt.toISOString()
  await getDb().execute(
    sql`DELETE FROM auth_rate_limit_buckets WHERE reset_at <= ${nowIso}::timestamptz`
  )
  const [bucket] = await getDb().execute(sql`
    INSERT INTO auth_rate_limit_buckets (bucket_key, request_count, reset_at)
    VALUES (${key}, 1, ${resetAtIso}::timestamptz)
    ON CONFLICT (bucket_key)
    DO UPDATE SET
      request_count = CASE
        WHEN auth_rate_limit_buckets.reset_at <= ${nowIso}::timestamptz THEN 1
        ELSE auth_rate_limit_buckets.request_count + 1
      END,
      reset_at = CASE
        WHEN auth_rate_limit_buckets.reset_at <= ${nowIso}::timestamptz THEN ${resetAtIso}::timestamptz
        ELSE auth_rate_limit_buckets.reset_at
      END,
      updated_at = NOW()
    RETURNING request_count, reset_at
  `)
  const requestCount = Number((bucket as { request_count: number | string }).request_count)
  const bucketResetAt = new Date((bucket as { reset_at: Date | string }).reset_at)
  if (requestCount <= max) return true
  const retryAfterSeconds = Math.ceil((bucketResetAt.getTime() - now.getTime()) / 1000)
  reply.header('Retry-After', String(retryAfterSeconds)).status(429).send({
    code: 'rate_limit_exceeded',
    message: 'Too many attempts. Try again later.',
    retryAfterSeconds,
  })
  return false
}

const SessionParamsSchema = z.object({ sessionId: z.uuid() })

function registerMethodNotAllowed(fastify: FastifyApp, path: string): void {
  for (const method of ['GET', 'PUT', 'PATCH', 'DELETE'] as const) {
    fastify.route({
      method,
      url: path,
      schema: { response: { 405: methodNotAllowedResponseSchema } },
      handler: async (_req: FastifyRequest, reply: FastifyReply) =>
        reply.header('Allow', 'POST').status(405).send({
          code: 'method_not_allowed',
          message: 'Method Not Allowed',
        }),
    })
  }
}

export async function authRoutes(fastify: FastifyApp): Promise<void> {
  // Skipped under NODE_ENV=test by default (see isRateLimitEnforced) — real request-rate
  // buckets are wall-clock-based, so integration tests that register/log in many users as
  // fixture setup can flakily trip these limits depending on how fast the run executes.
  // register-rate-limit.test.ts opts back in via RATE_LIMIT_TEST_ENFORCE to cover enforcement.
  if (isRateLimitEnforced()) {
    await fastify.register(rateLimit, {
      max: 60,
      timeWindow: '1 minute',
      keyGenerator: (req: FastifyRequest) => req.ip,
      // Must carry `statusCode` — @fastify/rate-limit throws this value as the request error
      // (see its defaultErrorResponse), and the global error handler (app.ts) only recognizes
      // rate-limit errors via `error.statusCode === 429`. Without it, this fell through to the
      // generic branch and returned 500 instead of 429 whenever a route's limit was exceeded.
      errorResponseBuilder: (_req: FastifyRequest, context: { statusCode: number }) => ({
        statusCode: context.statusCode,
        code: 'rate_limit_exceeded',
        message: 'Too many authentication attempts',
      }),
    })
  }

  registerMethodNotAllowed(fastify, '/register')
  registerMethodNotAllowed(fastify, '/login')
  registerMethodNotAllowed(fastify, '/refresh')
  registerMethodNotAllowed(fastify, '/logout')
  registerMethodNotAllowed(fastify, '/mfa/enroll')
  registerMethodNotAllowed(fastify, '/mfa/verify-enrollment')
  registerMethodNotAllowed(fastify, '/mfa/regenerate-recovery-codes')
  registerMethodNotAllowed(fastify, '/mfa/recover')
  registerMethodNotAllowed(fastify, '/mfa/verify-login')

  secureRoute(fastify, {
    method: 'GET',
    url: '/me',
    schema: {
      response: {
        200: authMeResponseSchema,
        401: ApiErrorSchema,
      },
    },
    security: { writeAuditEvent: false },
    handler: async (ctx, _req, _reply) => {
      const secureCtx = ctx as SecureRouteContext
      const authContext = secureCtx.auth
      const mfaStatus = await getMfaStatus(authContext.userId, secureCtx.tx)
      const enforcementStatus = await loadMfaEnforcementStatus(authContext, secureCtx.tx)
      const [org] = await secureCtx.tx
        .select({ name: organizations.name })
        .from(organizations)
        .where(eq(organizations.id, authContext.orgId))
        .limit(1)
      return {
        data: {
          userId: authContext.userId,
          orgId: authContext.orgId,
          orgName: org?.name ?? '',
          sessionId: authContext.sessionId,
          orgRole: authContext.orgRole,
          isPlatformOperator: authContext.isPlatformOperator,
          ...mfaStatus,
          mfaStatus: enforcementStatus.mfaStatus,
        },
      }
    },
  })

  secureRoute(fastify, {
    method: 'POST',
    url: '/mfa/enroll',
    schema: {
      response: {
        200: mfaEnrollResponseSchema,
        401: ApiErrorSchema,
        409: ApiErrorSchema,
        429: ApiErrorSchema,
      },
    },
    security: {
      rateLimit: { max: 10, timeWindowMs: 60 * 60 * 1000 },
      writeAuditEvent: false, // MFA service writes the specific audit row through secureCtx.tx.
    },
    handler: async (ctx, _req, reply) => {
      const secureCtx = ctx as SecureRouteContext
      return sendMfaAction(reply, () =>
        enrollMfa(secureCtx.auth, metaFromRequest(_req), secureCtx.tx)
      )
    },
  })

  secureRoute(fastify, {
    method: 'POST',
    url: '/mfa/verify-enrollment',
    schema: {
      body: mfaVerifyEnrollmentBodySchema,
      response: {
        200: mfaVerifyEnrollmentResponseSchema,
        401: ApiErrorSchema,
        409: ApiErrorSchema,
        422: ApiErrorSchema,
        429: ApiErrorSchema,
      },
    },
    security: {
      rateLimit: { max: 20, timeWindowMs: 15 * 60 * 1000 },
      writeAuditEvent: false, // MFA service writes the specific audit row through secureCtx.tx.
    },
    handler: async (ctx, req, reply) => {
      const secureCtx = ctx as SecureRouteContext
      const parsed = parseBody(mfaVerifyEnrollmentBodySchema, req, reply)
      if (!parsed.success) return parsed.reply
      return sendMfaAction(reply, () =>
        verifyEnrollment(secureCtx.auth, parsed.data, metaFromRequest(req), secureCtx.tx)
      )
    },
  })

  secureRoute(fastify, {
    method: 'POST',
    url: '/mfa/regenerate-recovery-codes',
    schema: {
      body: mfaRegenerateBodySchema,
      response: {
        200: mfaRegenerateResponseSchema,
        401: ApiErrorSchema,
        409: ApiErrorSchema,
        422: ApiErrorSchema,
        429: ApiErrorSchema,
      },
    },
    security: {
      rateLimit: { max: 5, timeWindowMs: 60 * 60 * 1000 },
      writeAuditEvent: false, // MFA service writes the specific audit row through secureCtx.tx.
    },
    handler: async (ctx, req, reply) => {
      const secureCtx = ctx as SecureRouteContext
      const parsed = parseBody(mfaRegenerateBodySchema, req, reply)
      if (!parsed.success) return parsed.reply
      const result = await sendMfaAction(reply, () =>
        regenerateRecoveryCodes(secureCtx.auth, parsed.data, metaFromRequest(req), secureCtx.tx)
      )
      if ('data' in result) {
        await sendPendingMfaNotifications(fastify, result.data.notificationJobs)
      }
      return result
    },
  })

  secureRoute(fastify, {
    method: 'GET',
    url: '/sessions',
    schema: {
      response: {
        200: sessionsListResponseSchema,
        401: ApiErrorSchema,
        429: ApiErrorSchema,
      },
    },
    security: { rateLimit: { max: 30 }, writeAuditEvent: false },
    handler: async (ctx, _req, _reply) => {
      const secureCtx = ctx as SecureRouteContext
      const sessionsList = await listSessions(
        secureCtx.auth.userId,
        secureCtx.auth.orgId,
        secureCtx.auth.jti,
        secureCtx.tx
      )
      return { data: sessionsList }
    },
  })

  secureRoute(fastify, {
    method: 'DELETE',
    url: '/sessions',
    schema: {
      response: {
        200: revokeOtherSessionsResponseSchema,
        401: ApiErrorSchema,
        429: ApiErrorSchema,
        503: ApiErrorSchema,
      },
    },
    security: {
      rateLimit: { max: 10 },
      writeAuditEvent: false, // Session service writes the specific audit row through secureCtx.tx.
    },
    handler: async (ctx, _req, reply) => {
      const secureCtx = ctx as SecureRouteContext
      try {
        const result = await revokeAllOtherSessions({
          userId: secureCtx.auth.userId,
          orgId: secureCtx.auth.orgId,
          currentJti: secureCtx.auth.jti,
          actorUserId: secureCtx.auth.userId,
          tx: secureCtx.tx,
        })
        return { data: result }
      } catch {
        return sendAppError(
          reply,
          new AppError('service_unavailable', 'Session revocation service is unavailable', 503)
        )
      }
    },
  })

  secureRoute(fastify, {
    method: 'DELETE',
    url: '/sessions/:sessionId',
    schema: {
      response: {
        401: ApiErrorSchema,
        404: ApiErrorSchema,
        422: ApiErrorSchema,
        429: ApiErrorSchema,
      },
    },
    security: {
      rateLimit: { max: 10 },
      writeAuditEvent: false, // Session service writes the specific audit row through secureCtx.tx.
    },
    handler: async (ctx, req, reply) => {
      const secureCtx = ctx as SecureRouteContext
      const parsed = SessionParamsSchema.safeParse(req.params)
      if (!parsed.success) return reply.status(422).send(validationError(parsed.error, 'params'))
      const result = await revokeSessionById(parsed.data.sessionId, {
        actorUserId: secureCtx.auth.userId,
        scope: parsed.data.sessionId === secureCtx.auth.sessionId ? 'logout' : 'single',
        expectedUserId: secureCtx.auth.userId,
        expectedOrgId: secureCtx.auth.orgId,
        tx: secureCtx.tx,
      })
      if (!result.revoked) return sendAppError(reply, sessionNotFound())
      if (parsed.data.sessionId === secureCtx.auth.sessionId) {
        clearAuthCookies(reply as unknown as CookieReply)
      }
      reply.status(204)
      return undefined
    },
  })

  secureRoute(fastify, {
    method: 'POST',
    url: '/logout',
    schema: {
      response: {
        204: z.null(),
        401: ApiErrorSchema,
        429: ApiErrorSchema,
      },
    },
    security: {
      rateLimit: { max: 30 },
      writeAuditEvent: false, // Session service writes the specific audit row through secureCtx.tx.
    },
    handler: async (ctx, _req, reply) => {
      const secureCtx = ctx as SecureRouteContext
      await revokeSessionById(secureCtx.auth.sessionId, {
        actorUserId: secureCtx.auth.userId,
        scope: 'logout',
        expectedUserId: secureCtx.auth.userId,
        expectedOrgId: secureCtx.auth.orgId,
        tx: secureCtx.tx,
      })
      clearAuthCookies(reply as unknown as CookieReply)
      reply.status(204)
      return undefined
    },
  })

  withRouteTypeProvider(fastify).route({
    method: 'POST',
    url: '/register',
    bodyLimit: 4096,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    attachValidation: true,
    schema: {
      body: RegisterRequestSchema,
      response: {
        201: registerRouteResponseSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        409: ApiErrorSchema,
        410: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      if (!env.AUTH_REGISTRATION_ENABLED) {
        return reply.status(403).send({
          code: 'registration_disabled',
          message: 'Registration is disabled on this vault',
        })
      }
      const normalized = normalizeEmailBodyForRoute(req.body, reply)
      if (!normalized.success) return normalized.reply
      const parsed = RegisterRequestSchema.safeParse(normalized.body)
      if (!parsed.success) return reply.status(422).send(validationError(parsed.error, 'body'))
      try {
        const result = await registerUser(parsed.data)
        return reply.status(201).send({ data: result })
      } catch (error) {
        if (error instanceof AppError) return sendAppError(reply, error)
        throw error
      }
    },
  })

  withRouteTypeProvider(fastify).route({
    method: 'POST',
    url: '/login',
    bodyLimit: 4096,
    attachValidation: true,
    schema: {
      body: LoginRequestSchema,
      response: {
        200: loginResponseSchema,
        401: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const normalized = normalizeEmailBodyForRoute(req.body, reply)
      if (!normalized.success) return normalized.reply
      const parsed = LoginRequestSchema.safeParse(normalized.body)
      if (!parsed.success) return reply.status(422).send(validationError(parsed.error, 'body'))
      try {
        const result = await loginUser(parsed.data, metaFromRequest(req))
        if (isMfaChallengeResult(result)) {
          clearAuthCookies(reply as unknown as CookieReply)
          return reply.send({ data: result })
        }
        return sendAuthSession(fastify, reply, result)
      } catch (error) {
        if (error instanceof AppError) return sendAppError(reply, error)
        throw error
      }
    },
  })

  withRouteTypeProvider(fastify).route({
    method: 'POST',
    url: '/mfa/verify-login',
    bodyLimit: 4096,
    // 20/min/IP is a broad shield, not the authoritative control (AC-9/ADR-1.12-09): ~4x the
    // default MFA_LOGIN_MAX_ATTEMPTS=5 leaves room for one legitimate retry-exhausted cycle
    // per minute per IP, while the DB-backed per-token attempt_count and the Story 1.9
    // failed-auth threshold worker remain the real brute-force defenses.
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    attachValidation: true,
    schema: {
      body: mfaVerifyLoginBodySchema,
      response: {
        200: mfaVerifyLoginResponseSchema,
        401: ApiErrorSchema,
        422: ApiErrorSchema,
        429: ApiErrorSchema,
      },
    },
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = parseBody(mfaVerifyLoginBodySchema, req, reply)
      if (!parsed.success) return parsed.reply
      try {
        const result = await verifyLogin(parsed.data, metaFromRequest(req))
        return sendAuthSession(fastify, reply, result)
      } catch (error) {
        if (error instanceof AppError) return sendAppError(reply, error)
        throw error
      }
    },
  })

  withRouteTypeProvider(fastify).route({
    method: 'POST',
    url: '/mfa/recover',
    bodyLimit: 4096,
    attachValidation: true,
    schema: {
      body: mfaRecoverBodySchema,
      response: {
        200: mfaRecoverResponseSchema,
        401: ApiErrorSchema,
        422: ApiErrorSchema,
        429: RateLimitExceededResponseSchema,
      },
    },
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const normalizedBody = await enforceIpRateLimitAndNormalizeEmailBody(req, reply)
      if (normalizedBody === null) return reply
      const parsed = await parseBodyAndEnforceEmailRateLimit(
        mfaRecoverBodySchema,
        normalizedBody,
        reply
      )
      if (!parsed) return reply
      try {
        const result = await recoverWithCode(parsed, metaFromRequest(req))
        await sendPendingMfaNotifications(fastify, result.notificationJobs)
        return sendAuthSession(fastify, reply, result, {
          remainingRecoveryCodes: result.remainingRecoveryCodes,
        })
      } catch (error) {
        if (error instanceof AppError) return sendAppError(reply, error)
        throw error
      }
    },
  })

  // Story 4.3 AC-9/AC-11/AC-12: self-initiated account recovery request. Public, anti-enumeration
  // (always 202 unless the no-admin boundary applies), dual IP+email rate-limited exactly like
  // /mfa/recover above.
  secureRoute(fastify, {
    method: 'POST',
    url: '/recovery/request',
    schema: {
      response: {
        202: RecoveryRequestResponseSchema,
        404: RecoveryNoAdminResponseSchema,
        422: ApiErrorSchema,
        429: RateLimitExceededResponseSchema,
      },
    },
    security: {
      requireAuth: false,
      writeAuditEvent: false,
      // AC-11's dual IP+email bucket scheme is enforced manually below via
      // enforceRecoverRateLimit (same helper /mfa/recover uses) — disable SecureRoute's own
      // single-bucket limiter so the two don't double-count.
      rateLimit: false,
    },
    handler: async (_ctx, req: FastifyRequest, reply: FastifyReply) => {
      const normalizedBody = await enforceIpRateLimitAndNormalizeEmailBody(req, reply)
      if (normalizedBody === null) return reply
      const parsed = await parseBodyAndEnforceEmailRateLimit(
        RecoveryRequestBodySchema,
        normalizedBody,
        reply
      )
      if (!parsed) return reply
      try {
        const result = await requestSelfRecovery(parsed.email, req)
        if (result.blocked) {
          return reply.status(404).send({
            code: 'no_admin_available',
            message:
              'This account cannot use self-service recovery. Contact your platform administrator.',
          })
        }
        reply.status(202)
        return { message: 'If that email is registered, a recovery link has been sent.' }
      } catch (error) {
        return sendRecoveryFailure(reply, error)
      }
    },
  })

  // Story 4.3 AC-13: public token peek — masked email, no mutation, used by the web UI to decide
  // what to render before submitting anything (mirrors GET /invitations/:token's peek role).
  secureRoute(fastify, {
    method: 'GET',
    url: '/recovery/:token',
    schema: {
      response: {
        200: RecoveryPeekResponseSchema,
        404: ApiErrorSchema,
        409: ApiErrorSchema,
        410: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      requireAuth: false,
      writeAuditEvent: false,
      rateLimit: { max: 30, timeWindowMs: 60_000, key: 'GET /api/v1/auth/recovery/:token' },
    },
    handler: async (_ctx, req: FastifyRequest, reply: FastifyReply) => {
      const parsed = parseRecoveryTokenParams(req, reply)
      if (!parsed) return reply
      const result = await peekRecoveryToken(parsed.token)
      if (!result.ok) return sendRecoveryStatusError(reply, result.error)
      return { data: { email: result.email, mfaCurrentlyEnrolled: result.mfaCurrentlyEnrolled } }
    },
  })

  // Story 4.3 AC-15/D1: stages a fresh TOTP secret for the recovery token's user. Does not
  // consume the token — only /recovery/:token/complete does.
  secureRoute(fastify, {
    method: 'POST',
    url: '/recovery/:token/mfa/start',
    schema: {
      response: {
        200: RecoveryMfaStartResponseSchema,
        404: ApiErrorSchema,
        409: ApiErrorSchema,
        410: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      requireAuth: false,
      writeAuditEvent: false,
      rateLimit: {
        max: 10,
        timeWindowMs: 60_000,
        key: 'POST /api/v1/auth/recovery/:token/mfa/start',
      },
    },
    handler: async (_ctx, req: FastifyRequest, reply: FastifyReply) => {
      const parsed = parseRecoveryTokenParams(req, reply)
      if (!parsed) return reply
      const result = await startRecoveryMfa(parsed.token)
      if (!result.ok) return sendRecoveryStatusError(reply, result.error)
      return {
        data: { otpauthUrl: result.otpauthUrl, secret: result.secret, qrCodeSvg: result.qrCodeSvg },
      }
    },
  })

  // Story 4.3 AC-14/AC-15/AC-19: recovery completion — password reset, optional MFA re-enrollment
  // confirm, and multi-org session invalidation, all in one transaction (recovery.ts).
  secureRoute(fastify, {
    method: 'POST',
    url: '/recovery/:token/complete',
    schema: {
      body: RecoveryCompleteBodySchema,
      response: {
        200: RecoveryCompleteResponseSchema,
        404: ApiErrorSchema,
        409: ApiErrorSchema,
        410: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      requireAuth: false,
      writeAuditEvent: false,
      rateLimit: {
        max: 10,
        timeWindowMs: 60_000,
        key: 'POST /api/v1/auth/recovery/:token/complete',
      },
    },
    handler: async (_ctx, req: FastifyRequest, reply: FastifyReply) => {
      const paramsParsed = parseRecoveryTokenParams(req, reply)
      if (!paramsParsed) return reply
      const bodyParsed = RecoveryCompleteBodySchema.safeParse(req.body)
      if (!bodyParsed.success)
        return reply.status(422).send(validationError(bodyParsed.error, 'body'))
      try {
        const result = await completeAccountRecovery(paramsParsed.token, bodyParsed.data, req)
        if (!result.ok) return sendRecoveryStatusError(reply, result.error)
        return {
          data: {
            email: result.email,
            sessionsRevoked: result.sessionsRevoked,
            mfaReEnrolled: result.mfaReEnrolled,
            recoveryCodes: result.recoveryCodes,
          },
        }
      } catch (error) {
        return sendRecoveryFailure(reply, error)
      }
    },
  })

  fastify.route({
    method: 'POST',
    url: '/refresh',
    bodyLimit: 4096,
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    schema: {
      response: {
        200: refreshResponseSchema,
        401: ApiErrorSchema,
      },
    },
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const refreshOpaque = (req as unknown as { cookies?: Record<string, string | undefined> })
        .cookies?.['refresh-token']
      if (!refreshOpaque) {
        return reply
          .status(401)
          .send({ code: 'refresh_token_missing', message: 'Refresh token is missing' })
      }
      if (refreshOpaque.length > 128) {
        return reply
          .status(401)
          .send({ code: 'refresh_token_invalid', message: 'Refresh token is invalid' })
      }
      try {
        const result = await refreshSession(
          refreshOpaque,
          metaFromRequest(req),
          accessTokenExpFromRequest(fastify, req)
        )
        setAuthCookies(
          reply as unknown as CookieReply,
          await buildCookieTokens(fastify, result.tokens)
        )
        return reply.send({ data: { expiresAt: result.expiresAt } })
      } catch (error) {
        if (error instanceof AppError) return sendAppError(reply, error)
        throw error
      }
    },
  })
}
