import type { FastifyReply } from 'fastify/types/reply.js'
import type { FastifyRequest } from 'fastify/types/request.js'
import rateLimit from '@fastify/rate-limit'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { AppError } from '../../lib/errors.js'
import { env } from '../../config/env.js'
import { LoginRequestSchema, RegisterRequestSchema } from './schema.js'
import { normalizeEmail } from './normalize.js'
import { clearAuthCookies, setAuthCookies, type CookieReply } from './tokens.js'
import { loginUser, refreshSession, registerUser, type TokenMaterial } from './service.js'

type JwtFastify = FastifyApp & {
  jwt: {
    sign: (
      payload: Record<string, unknown>,
      options: { jti: string; expiresIn: number }
    ) => Promise<string> | string
  }
}

function validationError(error: { issues: { path: PropertyKey[]; message: string }[] }) {
  const details: Record<string, string[]> = {}
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? 'body')
    details[key] = [...(details[key] ?? []), issue.message]
  }
  return { code: 'validation_error', message: 'Request validation failed', details }
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
