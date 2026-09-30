import rateLimit from '@fastify/rate-limit'
import type { FastifyRequest } from 'fastify'
import type { FastifyApp } from './fastify-app.js'
import { isRateLimitEnforced } from './route-helpers.js'

const TIME_WINDOW = '1 minute'
const DEDUPE_CAP = 5_000
const LOG_MESSAGE = 'CLI auth rate limit exceeded'

/**
 * The only knobs a caller gets. Deliberately does NOT expose `global`, `allowList`,
 * `skipOnError`, `ban`, `continueExceeding`, `hook` or `keyGenerator`: each one silently weakens
 * or reshapes the limit (a route-scoped opt-out, an unlimited caller, fail-open on store errors,
 * a different status, a moving window, a later hook that runs after body parsing, a spoofable key).
 */
export type IpRateLimitOptions = {
  max: number
  message: string
  logEventType: string
}

/**
 * Bounded "have I already logged this (route, key, window)?" memory. Oldest-first eviction at
 * `cap` entries, so an attacker spraying IPs cannot grow it without bound; an evicted key merely
 * logs once more.
 */
export function createExceededLogDeduper(cap: number = DEDUPE_CAP) {
  const windowEnds = new Map<string, number>()
  return {
    shouldLog(dedupeKey: string, nowMs: number, windowEndMs: number): boolean {
      const existing = windowEnds.get(dedupeKey)
      if (existing !== undefined && nowMs < existing) return false
      windowEnds.delete(dedupeKey)
      if (windowEnds.size >= cap) {
        const oldest = windowEnds.keys().next().value
        if (oldest !== undefined) windowEnds.delete(oldest)
      }
      windowEnds.set(dedupeKey, windowEndMs)
      return true
    },
    size(): number {
      return windowEnds.size
    },
  }
}

/**
 * Story 43.8: registers `@fastify/rate-limit` as a per-IP limiter for every route the calling
 * plugin declares AFTER this call (the plugin's `onRoute` hook only sees later routes in the same
 * encapsulation context — call it as the plugin's first statement). Built for route plugins that
 * are siblings of `authRoutes` in app.ts and therefore never inherit its limiter (previously
 * `cliLoginRoutes`' `config.rateLimit` blocks were inert for exactly this reason).
 *
 * - **Key:** no `keyGenerator` is passed on purpose (Decision D2). The plugin's default key is
 *   `normalizeIP(req.ip, 64)`: IPv4-mapped IPv6 collapses to IPv4 and IPv6 is grouped by /64, so
 *   rotating host bits inside one /64 buys no fresh budget. `req.ip` already honours
 *   `TRUST_PROXY`/`TRUST_PROXY_HOPS`; request headers never mint a bucket on their own.
 * - **Precedence:** the plugin's default `onRequest` hook runs before body parsing, validation
 *   and the handler, so an over-limit request gets 429 ahead of 403/413/422 and never reaches a
 *   password hash, a failed-auth row, an audit row or a refresh-token rotation.
 * - **Buckets:** a route with its own object `config.rateLimit` gets its own bucket; every route
 *   in the scope WITHOUT one (e.g. the `registerMethodNotAllowed` 405 stubs) shares this
 *   registration's global bucket — acceptable, since a caller only spends its own IP's budget.
 * - **429 body:** `{ code: 'rate_limit_exceeded', message }` with `statusCode` on the thrown
 *   value, which app.ts's error handler needs to answer 429 rather than 500.
 * - **Logging (AC-6):** one warn line per (route, key, window), never per 429. The cost is
 *   attacker-bounded: a new line needs a key to first spend `max + 1` requests in a window.
 *   Logging failures are swallowed so they can never turn the 429 into a 500.
 *
 * A no-op when `isRateLimitEnforced()` is false (NODE_ENV=test + RATE_LIMIT_TEST_BYPASS=true).
 */
export async function registerIpRateLimit(
  fastify: FastifyApp,
  options: IpRateLimitOptions
): Promise<void> {
  if (!isRateLimitEnforced()) return
  const deduper = createExceededLogDeduper()
  const exceededKeys = new WeakMap<FastifyRequest, string>()

  function logOnce(req: FastifyRequest, context: { max: number; ttl: number }): void {
    try {
      const key = exceededKeys.get(req)
      if (key === undefined) return
      const route = req.routeOptions.url ?? req.url
      const now = Date.now()
      if (!deduper.shouldLog(`${req.method} ${route} ${key}`, now, now + context.ttl)) return
      req.log.warn(
        {
          eventType: options.logEventType,
          route,
          method: req.method,
          ipKey: key,
          limit: context.max,
        },
        LOG_MESSAGE
      )
    } catch {
      // Never block the 429: a logging/dedupe failure must not surface as a 500.
    }
  }

  await fastify.register(rateLimit, {
    max: options.max,
    timeWindow: TIME_WINDOW,
    onExceeded: (req: FastifyRequest, key: string) => {
      exceededKeys.set(req, key)
    },
    errorResponseBuilder: (
      req: FastifyRequest,
      context: { statusCode: number; max: number; ttl: number }
    ) => {
      logOnce(req, context)
      return {
        statusCode: context.statusCode,
        code: 'rate_limit_exceeded',
        message: options.message,
      }
    },
  })
}
