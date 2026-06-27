import type { FastifyReply } from 'fastify/types/reply.js'
import type { FastifyRequest } from 'fastify/types/request.js'
import rateLimit from '@fastify/rate-limit'
import { z } from 'zod/v4'
import { sql } from 'drizzle-orm'
import { getDb } from '@project-vault/db'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { AppError } from '../../lib/errors.js'
import { env } from '../../config/env.js'
import { ApiErrorSchema, withRouteTypeProvider } from '../../lib/api-contracts.js'
import { validationError } from '../../lib/route-helpers.js'
import { secureRoute, type SecureRouteContext } from '../../lib/secure-route.js'
import {
  LoginRequestSchema,
  RegisterRequestSchema,
  authMeResponseSchema,
  mfaEnrollResponseSchema,
  mfaRegenerateBodySchema,
  mfaRegenerateResponseSchema,
  mfaRecoverBodySchema,
  mfaRecoverResponseSchema,
  mfaVerifyEnrollmentBodySchema,
  mfaVerifyEnrollmentResponseSchema,
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
import {
  listSessions,
  loginUser,
  refreshSession,
  registerUser,
  type TokenMaterial,
} from './service.js'
import { loadMfaEnforcementStatus } from './mfa-enforcement.js'
import { revokeAllOtherSessions, revokeSessionById, sessionNotFound } from './session-revoke.js'

type JwtFastify = FastifyApp & {
  jwt: {
    sign: (
      payload: Record<string, unknown>,
      options: { jti: string; expiresIn: number }
    ) => Promise<string> | string
    decode: (token: string) => unknown
  }
}
type ParsedBody<T> = { success: true; data: T } | { success: false; reply: FastifyReply }
type AuthSessionResult = {
  userId: string
  orgId: string
  expiresAt: string
  tokens: TokenMaterial
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

async function sendMfaAction<T>(
  reply: FastifyReply,
  action: () => Promise<T>
): Promise<FastifyReply> {
  try {
    return reply.send({ data: await action() })
  } catch (error) {
    if (error instanceof AppError) return sendAppError(reply, error)
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
      handler: async (_req: FastifyRequest, reply: FastifyReply) =>
        reply.header('Allow', 'POST').status(405).send({
          code: 'method_not_allowed',
          message: 'Method Not Allowed',
        }),
    })
  }
}

export async function authRoutes(fastify: FastifyApp): Promise<void> {
  await fastify.register(rateLimit, {
    max: 60,
    timeWindow: '1 minute',
    keyGenerator: (req: FastifyRequest) => req.ip,
    errorResponseBuilder: () => ({
      code: 'rate_limit_exceeded',
      message: 'Too many authentication attempts',
    }),
  })

  registerMethodNotAllowed(fastify, '/register')
  registerMethodNotAllowed(fastify, '/login')
  registerMethodNotAllowed(fastify, '/refresh')
  registerMethodNotAllowed(fastify, '/logout')
  registerMethodNotAllowed(fastify, '/mfa/enroll')
  registerMethodNotAllowed(fastify, '/mfa/verify-enrollment')
  registerMethodNotAllowed(fastify, '/mfa/regenerate-recovery-codes')
  registerMethodNotAllowed(fastify, '/mfa/recover')

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
      const authContext = (ctx as SecureRouteContext).auth
      const mfaStatus = await getMfaStatus(authContext.userId)
      const enforcementStatus = await loadMfaEnforcementStatus(authContext)
      return {
        data: {
          userId: authContext.userId,
          orgId: authContext.orgId,
          sessionId: authContext.sessionId,
          orgRole: authContext.orgRole,
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
      writeAuditEvent: false,
    },
    handler: async (ctx, _req, reply) => {
      const authContext = (ctx as SecureRouteContext).auth
      return sendMfaAction(reply, () => enrollMfa(authContext, metaFromRequest(_req)))
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
      writeAuditEvent: false,
    },
    handler: async (ctx, req, reply) => {
      const authContext = (ctx as SecureRouteContext).auth
      const parsed = parseBody(mfaVerifyEnrollmentBodySchema, req, reply)
      if (!parsed.success) return parsed.reply
      return sendMfaAction(reply, () =>
        verifyEnrollment(authContext, parsed.data, metaFromRequest(req))
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
      writeAuditEvent: false,
    },
    handler: async (ctx, req, reply) => {
      const authContext = (ctx as SecureRouteContext).auth
      const parsed = parseBody(mfaRegenerateBodySchema, req, reply)
      if (!parsed.success) return parsed.reply
      return sendMfaAction(reply, () =>
        regenerateRecoveryCodes(authContext, parsed.data, metaFromRequest(req))
      )
    },
  })

  secureRoute(fastify, {
    method: 'GET',
    url: '/sessions',
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
    security: { rateLimit: { max: 10 }, writeAuditEvent: false },
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
    security: { rateLimit: { max: 10 }, writeAuditEvent: false },
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
    security: { rateLimit: { max: 30 }, writeAuditEvent: false },
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

  fastify.route({
    method: 'POST',
    url: '/register',
    bodyLimit: 4096,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
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

  fastify.route({
    method: 'POST',
    url: '/login',
    bodyLimit: 4096,
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const normalized = normalizeEmailBodyForRoute(req.body, reply)
      if (!normalized.success) return normalized.reply
      const parsed = LoginRequestSchema.safeParse(normalized.body)
      if (!parsed.success) return reply.status(422).send(validationError(parsed.error, 'body'))
      try {
        const result = await loginUser(parsed.data, metaFromRequest(req))
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
        429: z.object({
          code: z.literal('rate_limit_exceeded'),
          message: z.string(),
          retryAfterSeconds: z.number().int().positive(),
        }),
      },
    },
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      if (!(await enforceRecoverRateLimit(`ip:${req.ip}`, 10, reply))) return reply
      const normalized = normalizeEmailBodyForRoute(req.body, reply)
      if (!normalized.success) return normalized.reply
      const parsed = mfaRecoverBodySchema.safeParse(normalized.body)
      if (!parsed.success) return reply.status(422).send(validationError(parsed.error, 'body'))
      const normalizedEmail = parsed.data.email
      if (!(await enforceRecoverRateLimit(`email:${normalizedEmail}`, 5, reply))) return reply
      try {
        const result = await recoverWithCode(parsed.data, metaFromRequest(req))
        return sendAuthSession(fastify, reply, result, {
          remainingRecoveryCodes: result.remainingRecoveryCodes,
        })
      } catch (error) {
        if (error instanceof AppError) return sendAppError(reply, error)
        throw error
      }
    },
  })

  fastify.route({
    method: 'POST',
    url: '/refresh',
    bodyLimit: 4096,
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
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
