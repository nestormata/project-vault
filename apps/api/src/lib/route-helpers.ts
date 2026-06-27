import type { FastifyReply } from 'fastify/types/reply.js'
import type { FastifyRequest } from 'fastify/types/request.js'
import type { FastifyApp } from './fastify-app.js'

const userRateLimitWindows = new Map<string, { count: number; resetAt: number }>()

export const ACCESS_TOKEN_MISSING_RESPONSE = {
  code: 'access_token_missing',
  message: 'Access token is missing',
}

export function validationError(
  error: { issues: { path: PropertyKey[]; message: string }[] },
  fallbackPath: string
) {
  const details = new Map<string, string[]>()
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? fallbackPath)
    details.set(key, [...(details.get(key) ?? []), issue.message])
  }
  return {
    code: 'validation_error',
    message: 'Request validation failed',
    details: Object.fromEntries(details),
  }
}

export function authPreHandler(fastify: FastifyApp) {
  return (fastify as unknown as { authenticate: unknown }).authenticate
}

export function requireAuthContext(req: FastifyRequest, reply: FastifyReply) {
  const authContext = req.authContext
  if (!authContext) {
    reply.status(401).send(ACCESS_TOKEN_MISSING_RESPONSE)
    return null
  }
  return authContext
}

export function enforceUserRateLimit({
  userId,
  key,
  max,
  timeWindowMs = 60_000,
  reply,
}: {
  userId: string
  key: string
  max: number
  timeWindowMs?: number
  reply: FastifyReply
}): boolean {
  const now = Date.now()
  const bucketKey = `${userId}:${key}`
  const current = userRateLimitWindows.get(bucketKey)
  const bucket =
    !current || current.resetAt <= now ? { count: 0, resetAt: now + timeWindowMs } : current
  bucket.count += 1
  userRateLimitWindows.set(bucketKey, bucket)
  if (bucket.count <= max) return true
  reply.status(429).send({
    code: 'rate_limit_exceeded',
    message: 'Too many authenticated requests',
    retryAfter: Math.ceil((bucket.resetAt - now) / 1000),
  })
  return false
}
