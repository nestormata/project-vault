import type { FastifyReply } from 'fastify/types/reply.js'
import type { FastifyRequest } from 'fastify/types/request.js'
import rateLimit from '@fastify/rate-limit'
import { z } from 'zod/v4'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { AppError } from '../../lib/errors.js'
import { env } from '../../config/env.js'
import {
  authPreHandler,
  enforceUserRateLimit,
  requireAuthContext,
  validationError,
} from '../../lib/route-helpers.js'
import { LoginRequestSchema, RegisterRequestSchema } from './schema.js'
import { normalizeEmail } from './normalize.js'
import { clearAuthCookies, setAuthCookies, type CookieReply } from './tokens.js'
import {
  listSessions,
  loginUser,
  refreshSession,
  registerUser,
  type TokenMaterial,
} from './service.js'
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
type AuthContext = NonNullable<FastifyRequest['authContext']>
type ProtectedRouteOptions = {
  method: 'GET' | 'POST' | 'DELETE'
  url: string
  rateLimitMax?: number
  handler: (
    authContext: AuthContext,
    req: FastifyRequest,
    reply: FastifyReply
  ) => Promise<unknown> | unknown
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

function registerProtectedRoute(fastify: FastifyApp, options: ProtectedRouteOptions): void {
  fastify.route({
    method: options.method,
    url: options.url,
    preHandler: [authPreHandler(fastify)],
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const authContext = requireAuthContext(req, reply)
      if (!authContext) return reply
      if (
        options.rateLimitMax &&
        !enforceUserRateLimit({
          userId: authContext.userId,
          key: `${options.method} ${options.url}`,
          max: options.rateLimitMax,
          reply,
        })
      ) {
        return reply
      }
      return options.handler(authContext, req, reply)
    },
  })
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

  registerProtectedRoute(fastify, {
    method: 'GET',
    url: '/me',
    handler: (authContext, _req, reply) =>
      reply.send({
        data: {
          userId: authContext.userId,
          orgId: authContext.orgId,
          sessionId: authContext.sessionId,
          orgRole: authContext.orgRole,
        },
      }),
  })

  registerProtectedRoute(fastify, {
    method: 'GET',
    url: '/sessions',
    rateLimitMax: 30,
    handler: async (authContext, _req, reply) => {
      const sessionsList = await listSessions(
        authContext.userId,
        authContext.orgId,
        authContext.jti
      )
      return reply.send({ data: sessionsList })
    },
  })

  registerProtectedRoute(fastify, {
    method: 'DELETE',
    url: '/sessions',
    rateLimitMax: 10,
    handler: async (authContext, _req, reply) => {
      try {
        const result = await revokeAllOtherSessions({
          userId: authContext.userId,
          orgId: authContext.orgId,
          currentJti: authContext.jti,
          actorUserId: authContext.userId,
        })
        return reply.send({ data: result })
      } catch {
        return sendAppError(
          reply,
          new AppError('service_unavailable', 'Session revocation service is unavailable', 503)
        )
      }
    },
  })

  registerProtectedRoute(fastify, {
    method: 'DELETE',
    url: '/sessions/:sessionId',
    rateLimitMax: 10,
    handler: async (authContext, req, reply) => {
      const parsed = SessionParamsSchema.safeParse(req.params)
      if (!parsed.success) return reply.status(422).send(validationError(parsed.error, 'params'))
      const result = await revokeSessionById(parsed.data.sessionId, {
        actorUserId: authContext.userId,
        scope: parsed.data.sessionId === authContext.sessionId ? 'logout' : 'single',
        expectedUserId: authContext.userId,
        expectedOrgId: authContext.orgId,
      })
      if (!result.revoked) return sendAppError(reply, sessionNotFound())
      if (parsed.data.sessionId === authContext.sessionId) {
        clearAuthCookies(reply as unknown as CookieReply)
      }
      return reply.status(204).send()
    },
  })

  registerProtectedRoute(fastify, {
    method: 'POST',
    url: '/logout',
    rateLimitMax: 30,
    handler: async (authContext, _req, reply) => {
      await revokeSessionById(authContext.sessionId, {
        actorUserId: authContext.userId,
        scope: 'logout',
        expectedUserId: authContext.userId,
        expectedOrgId: authContext.orgId,
      })
      clearAuthCookies(reply as unknown as CookieReply)
      return reply.status(204).send()
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
        clearAuthCookies(reply as unknown as CookieReply)
        setAuthCookies(
          reply as unknown as CookieReply,
          await buildCookieTokens(fastify, result.tokens)
        )
        return reply.send({
          data: { userId: result.userId, orgId: result.orgId, expiresAt: result.expiresAt },
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
