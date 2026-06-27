import type { FastifyReply } from 'fastify/types/reply.js'
import type { FastifyRequest } from 'fastify/types/request.js'
import rateLimit from '@fastify/rate-limit'
import { z } from 'zod/v4'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { AppError } from '../../lib/errors.js'
import { env } from '../../config/env.js'
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
  }
}

function validationError(error: { issues: { path: PropertyKey[]; message: string }[] }) {
  const details = new Map<string, string[]>()
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? 'body')
    details.set(key, [...(details.get(key) ?? []), issue.message])
  }
  return {
    code: 'validation_error',
    message: 'Request validation failed',
    details: Object.fromEntries(details),
  }
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

function sendAppError(reply: FastifyReply, error: AppError) {
  return reply.status(error.statusCode).send({ code: error.code, message: error.message })
}

const SessionParamsSchema = z.object({ sessionId: z.uuid() })
const ACCESS_TOKEN_MISSING_RESPONSE = {
  code: 'access_token_missing',
  message: 'Access token is missing',
}

function authPreHandler(fastify: FastifyApp) {
  return (fastify as unknown as { authenticate: unknown }).authenticate
}

function requireAuthContext(req: FastifyRequest, reply: FastifyReply) {
  const authContext = req.authContext
  if (!authContext) {
    reply.status(401).send(ACCESS_TOKEN_MISSING_RESPONSE)
    return null
  }
  return authContext
}

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

  fastify.route({
    method: 'GET',
    url: '/me',
    preHandler: [authPreHandler(fastify)],
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const authContext = req.authContext
      if (!authContext) {
        return reply.status(401).send(ACCESS_TOKEN_MISSING_RESPONSE)
      }
      return reply.send({
        data: {
          userId: authContext.userId,
          orgId: authContext.orgId,
          sessionId: authContext.sessionId,
          orgRole: authContext.orgRole,
        },
      })
    },
  })

  fastify.route({
    method: 'GET',
    url: '/sessions',
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    preHandler: [authPreHandler(fastify)],
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const authContext = requireAuthContext(req, reply)
      if (!authContext) return reply
      const sessionsList = await listSessions(authContext.userId, authContext.jti)
      return reply.send({ data: sessionsList })
    },
  })

  fastify.route({
    method: 'DELETE',
    url: '/sessions',
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    preHandler: [authPreHandler(fastify)],
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const authContext = requireAuthContext(req, reply)
      if (!authContext) return reply
      const result = await revokeAllOtherSessions({
        userId: authContext.userId,
        currentJti: authContext.jti,
        actorUserId: authContext.userId,
      })
      return reply.send({ data: result })
    },
  })

  fastify.route({
    method: 'DELETE',
    url: '/sessions/:sessionId',
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    preHandler: [authPreHandler(fastify)],
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const authContext = requireAuthContext(req, reply)
      if (!authContext) return reply
      const parsed = SessionParamsSchema.safeParse(req.params)
      if (!parsed.success) return reply.status(422).send(validationError(parsed.error))
      const result = await revokeSessionById(parsed.data.sessionId, {
        actorUserId: authContext.userId,
        scope: parsed.data.sessionId === authContext.sessionId ? 'logout' : 'single',
        expectedUserId: authContext.userId,
      })
      if (!result.revoked) return sendAppError(reply, sessionNotFound())
      if (parsed.data.sessionId === authContext.sessionId) {
        clearAuthCookies(reply as unknown as CookieReply)
      }
      return reply.status(204).send()
    },
  })

  fastify.route({
    method: 'POST',
    url: '/logout',
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    preHandler: [authPreHandler(fastify)],
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const authContext = requireAuthContext(req, reply)
      if (!authContext) return reply
      await revokeSessionById(authContext.sessionId, {
        actorUserId: authContext.userId,
        scope: 'logout',
        expectedUserId: authContext.userId,
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
      if (!parsed.success) return reply.status(422).send(validationError(parsed.error))
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
      if (!parsed.success) return reply.status(422).send(validationError(parsed.error))
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
        const result = await refreshSession(refreshOpaque, metaFromRequest(req))
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
