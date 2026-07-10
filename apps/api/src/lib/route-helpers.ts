import type { FastifyReply } from 'fastify/types/reply.js'
import type { FastifyRequest } from 'fastify/types/request.js'
import type { FastifyApp } from './fastify-app.js'

const userRateLimitWindows = new Map<string, { count: number; resetAt: number }>()

/**
 * Rate limiters are real wall-clock-bucketed counters shared across every request an app
 * instance handles. Integration tests that register/log in many users as fixture setup
 * (not testing rate limiting itself) can incidentally trip these limits depending on how
 * fast the suite happens to run — deterministic in intent, but flaky in practice, since a
 * faster CI run packs more calls into the same window than a slower local run does. Only
 * bypass enforcement when a test run opts in explicitly with RATE_LIMIT_TEST_BYPASS=true;
 * ambient NODE_ENV=test alone is never enough to disable production hardening.
 */
export function isRateLimitEnforced(): boolean {
  return !(process.env['NODE_ENV'] === 'test' && process.env['RATE_LIMIT_TEST_BYPASS'] === 'true')
}

export function validationError(
  error: { issues: { path: PropertyKey[]; message: string }[] },
  fallbackPath: string
) {
  const details = new Map<string, string[]>()
  let code = 'validation_error'
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? fallbackPath)
    details.set(key, [...(details.get(key) ?? []), issue.message])
    if (issue.message === 'invalid_cron') code = 'invalid_cron'
  }
  return {
    code,
    message: 'Request validation failed',
    details: Object.fromEntries(details),
  }
}

export type SafeParseSchema<T> = {
  safeParse: (
    value: unknown
  ) =>
    | { success: true; data: T }
    | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } }
}

function parseRequestPart<T>(
  schema: SafeParseSchema<T>,
  value: unknown,
  fallbackPath: 'body' | 'params',
  reply: FastifyReply
): { success: true; data: T } | { success: false } {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    reply.status(422).send(validationError(parsed.error, fallbackPath))
    return { success: false }
  }
  return { success: true, data: parsed.data }
}

export function parseBody<T>(
  schema: SafeParseSchema<T>,
  req: FastifyRequest,
  reply: FastifyReply
): { success: true; data: T } | { success: false } {
  return parseRequestPart(schema, req.body, 'body', reply)
}

export function parseParams<T>(
  schema: SafeParseSchema<T>,
  req: FastifyRequest,
  reply: FastifyReply
): T | null {
  const result = parseRequestPart(schema, req.params, 'params', reply)
  return result.success ? result.data : null
}

export function authPreHandler(fastify: FastifyApp) {
  return (fastify as unknown as { authenticate: unknown }).authenticate
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
  if (!isRateLimitEnforced()) return true
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
