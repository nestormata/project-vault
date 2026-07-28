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
    if (issue.message === 'invalid_link_url') code = 'invalid_link_url'
    // Story 14.6 AC-2(b): the org-sso-domains schema's domain-format refine sets this exact
    // message so a malformed domain surfaces the contract's invalid_domain_format code, not the
    // generic validation_error fallback.
    if (issue.message === 'invalid_domain_format') code = 'invalid_domain_format'
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
  fallbackPath: 'body' | 'params' | 'querystring',
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

// Story 13.3 Subtask 2.1 — query-string counterpart to parseParams/parseBody; malformed input
// (e.g. an empty or overlong `?field=`) is a 422 at this Zod layer, same convention as the others.
export function parseQuery<T>(
  schema: SafeParseSchema<T>,
  req: FastifyRequest,
  reply: FastifyReply
): T | null {
  const result = parseRequestPart(schema, req.query, 'querystring', reply)
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
