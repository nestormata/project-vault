import type { FastifyReply } from 'fastify/types/reply.js'
import type { FastifyRequest } from 'fastify/types/request.js'
import type { FastifyApp } from './fastify-app.js'

type RateWindow = { count: number; resetAt: number }

const userRateLimitWindows = new Map<string, RateWindow>()

/**
 * Story 71.9 (review fix): per-IP buckets live in their OWN bounded map. A per-IP key is chosen by
 * the caller (an IPv6 sprayer would otherwise grow the map for ever), but the bound must never
 * evict the per-user / per-kid windows of the other limiters, which share `userRateLimitWindows`:
 * an unauthenticated flood from many /64 prefixes would otherwise reset them. At the cap, expired
 * windows go first (swept at most once per second, so a flood cannot turn every request into a
 * full scan), then the oldest entry; an evicted IP merely starts a fresh window.
 */
export const USER_RATE_LIMIT_MAX_BUCKETS = 50_000
const BOUNDED_SWEEP_INTERVAL_MS = 1_000
const boundedRateLimitWindows = new Map<string, RateWindow>()
let nextBoundedSweepAt = 0

/** Test and diagnostics seam: how many windows are currently tracked (bounded = per-IP map). */
export function userRateLimitBucketCount(bounded = false): number {
  return (bounded ? boundedRateLimitWindows : userRateLimitWindows).size
}

function makeRoomForBoundedBucket(now: number): void {
  if (boundedRateLimitWindows.size < USER_RATE_LIMIT_MAX_BUCKETS) return
  if (now >= nextBoundedSweepAt) {
    nextBoundedSweepAt = now + BOUNDED_SWEEP_INTERVAL_MS
    for (const [bucketKey, window] of boundedRateLimitWindows) {
      if (window.resetAt <= now) boundedRateLimitWindows.delete(bucketKey)
    }
  }
  if (boundedRateLimitWindows.size < USER_RATE_LIMIT_MAX_BUCKETS) return
  const oldest = boundedRateLimitWindows.keys().next().value
  if (oldest !== undefined) boundedRateLimitWindows.delete(oldest)
}

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

/**
 * Story 20.13 (jscpd fix): extracted from `oauth-handoff-routes.ts`'s `callbackQueryParams` and
 * `public-route-routes.ts`'s own equivalent, which independently reimplemented the same
 * `request.query` -> `Record<string, string>` normalization (Fastify's parsed query values can be
 * `string | string[] | undefined`; only the first array element, if a string, survives — matching
 * both call sites' existing behavior byte-for-byte).
 */
export function normalizeQueryParams(request: FastifyRequest): Record<string, string> {
  if (!request.query || typeof request.query !== 'object') return {}
  return Object.fromEntries(
    Object.entries(request.query as Record<string, unknown>).map(([key, value]) => {
      const raw = Array.isArray(value) ? value[0] : value
      return [key, typeof raw === 'string' ? raw : '']
    })
  )
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
    // Story 1.21 AC-1: PasswordSchema's strength refine sets this exact message so a
    // length-padded-but-trivially-guessable password surfaces a distinguishing code rather
    // than the generic validation_error fallback.
    if (issue.message === 'password_too_weak') code = 'password_too_weak'
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

export type UserRateLimitInput = {
  userId: string
  key: string
  max: number
  timeWindowMs?: number
  /** Use the capped per-IP window map (attacker-chosen keys); never evicts the other limiters. */
  bounded?: boolean
}

export type UserRateLimitDecision = { allowed: true } | { allowed: false; retryAfter: number }

/**
 * The reply-free core of `enforceUserRateLimit` (Story 71.9): spends one unit of the bucket and
 * says whether the call is within budget, without sending anything. Same bypass rule as every
 * other limiter (`isRateLimitEnforced`).
 */
export function consumeUserRateLimit({
  userId,
  key,
  max,
  timeWindowMs = 60_000,
  bounded = false,
}: UserRateLimitInput): UserRateLimitDecision {
  if (!isRateLimitEnforced()) return { allowed: true }
  const now = Date.now()
  const bucketKey = `${userId}:${key}`
  const windows = bounded ? boundedRateLimitWindows : userRateLimitWindows
  const current = windows.get(bucketKey)
  if (!current && bounded) makeRoomForBoundedBucket(now)
  const bucket =
    !current || current.resetAt <= now ? { count: 0, resetAt: now + timeWindowMs } : current
  bucket.count += 1
  windows.set(bucketKey, bucket)
  if (bucket.count <= max) return { allowed: true }
  return { allowed: false, retryAfter: Math.ceil((bucket.resetAt - now) / 1000) }
}

export function enforceUserRateLimit({
  reply,
  retryAfterHeader = false,
  ...input
}: UserRateLimitInput & {
  reply: FastifyReply
  /** Story 71.3: also set the `Retry-After` response header (default: body field only). */
  retryAfterHeader?: boolean
}): boolean {
  const decision = consumeUserRateLimit(input)
  if (decision.allowed) return true
  if (retryAfterHeader) reply.header('Retry-After', String(decision.retryAfter))
  reply.status(429).send({
    code: 'rate_limit_exceeded',
    message: 'Too many authenticated requests',
    retryAfter: decision.retryAfter,
  })
  return false
}
