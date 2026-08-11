import type { FastifyRequest } from 'fastify/types/request.js'
import type { FastifyReply } from 'fastify/types/reply.js'
import { z } from 'zod/v4'
import rateLimit from '@fastify/rate-limit'
import { OperationalEvent } from '@project-vault/shared'
import type { FastifyApp } from '../lib/fastify-app.js'
import { isRateLimitEnforced } from '../lib/route-helpers.js'
import { operationalLog } from '../lib/logger.js'
import { deriveAggregateStatus, runStatusChecks, type DbPool } from '../modules/status/service.js'
import { recordStatusProbeOutcome } from '../modules/status/metrics.js'
import {
  operationalStatusTokenMatches,
  hashOperationalStatusToken,
} from '../modules/status/token.js'
import {
  findActiveOperationalStatusToken,
  findActiveOperationalStatusTokenByHash,
  touchOperationalStatusTokenLastUsed,
} from '../modules/status/token-store.js'
import { getReleaseVersion } from '../lib/package-version.js'

// AC-1/AC-7: same reason-code vocabulary the checks in modules/status/service.ts emit — kept as
// a plain string, not an enum, so it stays a stable public contract independent of internal
// refactors.
const CheckResultSchema = z.object({
  status: z.enum(['ok', 'degraded', 'unavailable', 'skipped']),
  reason: z.string().optional(),
})

const StatusResponseSchema = z.object({
  status: z.enum(['healthy', 'degraded', 'unavailable']),
  version: z.string(),
  timestamp: z.string(),
  checks: z.object({
    database: CheckResultSchema,
    vault: CheckResultSchema,
    disk: CheckResultSchema,
  }),
})

// AC-4: every failure mode (missing token when required, malformed header, wrong token, revoked
// token) collapses to this exact same body — never reveals which case applied.
const UnauthorizedResponseSchema = z.object({
  code: z.literal('unauthorized'),
  message: z.string(),
})

// AC-4: when no token is configured, a non-loopback caller gets a generic 404 rather than a
// distinguishable "this endpoint exists but you're not allowed" signal (undiscoverability, see
// Completion Notes for the 404-vs-401 rationale).
const NotFoundResponseSchema = z.object({
  code: z.literal('not_found'),
  message: z.string(),
})

// This is the loopback allowlist itself (AC-4), not an incidental literal — NOSONAR(typescript:S1313).
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']) // NOSONAR(typescript:S1313)

function isLoopback(ip: string): boolean {
  return LOOPBACK_ADDRESSES.has(ip)
}

// AC-4 hardening: this loopback check gates the entire safe-default (no token configured →
// allow only loopback callers). `req.ip` is proxy-trust-resolved — when TRUST_PROXY is enabled
// it reflects `X-Forwarded-For`, which a remote attacker fully controls. Use the raw untrusted
// socket address instead, similar in spirit to routes/metrics.ts's metricsRemoteAddress(), so
// this gate can never be spoofed via a forwarded-for header regardless of TRUST_PROXY config. If
// the socket has no remote address (already destroyed/errored), fail to a non-loopback sentinel
// rather than falling back to the spoofable `req.ip` — an indeterminate address must never be
// treated as trusted.
function rawRemoteAddress(req: FastifyRequest): string {
  return req.raw.socket.remoteAddress ?? 'unknown-socket'
}

// HTTP auth scheme names are case-insensitive (RFC 7235 §2.1) — some monitoring clients send
// `bearer` in lowercase, which must still be accepted.
function extractBearerToken(header: string | string[] | undefined): string | undefined {
  if (typeof header !== 'string') return undefined
  const match = /^Bearer\s+(\S+)$/i.exec(header)
  return match?.[1]
}

type AuthOutcome = { allowed: true; tokenId?: string } | { allowed: false; status: 401 | 404 }

/**
 * AC-4: safe-by-default access control.
 *  - No active token configured: only loopback callers are allowed (undiscoverable 404 for
 *    everyone else — never a distinguishable 401 that confirms the route exists).
 *  - Active token configured: a valid `Authorization: Bearer <token>` is required. Missing,
 *    malformed, wrong, or revoked tokens (revoked rows never match the active-token lookup, so
 *    they fall into the same "no match" branch as a wrong token) all return the same generic 401.
 */
async function resolveStatusAuth(req: FastifyRequest): Promise<AuthOutcome> {
  const activeToken = await findActiveOperationalStatusToken()

  if (!activeToken) {
    return isLoopback(rawRemoteAddress(req)) ? { allowed: true } : { allowed: false, status: 404 }
  }

  const presented = extractBearerToken(req.headers.authorization)
  if (!presented) return { allowed: false, status: 401 }

  const tokenHash = hashOperationalStatusToken(presented)
  const candidate = await findActiveOperationalStatusTokenByHash(tokenHash)
  if (!candidate || !operationalStatusTokenMatches(candidate.tokenHash, presented)) {
    return { allowed: false, status: 401 }
  }
  return { allowed: true, tokenId: candidate.id }
}

/**
 * Story 1.19: `GET /status` — the aggregate operational endpoint, distinct from the existing
 * unconditional `/health` liveness probe and `/ready` readiness probe (AC-2). Not registered via
 * secureRoute() (Dev Notes): its auth model (bearer token / loopback) is unrelated to org-scoped
 * session auth, so it is a plain fastify.route() with its own rate-limit plugin instance, same
 * shape as healthRoutes but with bespoke auth in the handler.
 */
export async function statusRoutes(
  fastify: FastifyApp,
  options: { dbPool?: DbPool }
): Promise<void> {
  if (isRateLimitEnforced()) {
    await fastify.register(rateLimit, {
      max: 30,
      timeWindow: '1 minute',
      // Same rationale as rawRemoteAddress() above: keying the limiter off the proxy-trust-
      // resolved req.ip would let a spoofed X-Forwarded-For value bucket every attacker request
      // under a different (or victim's) key, defeating rate limiting if TRUST_PROXY is ever
      // misconfigured.
      keyGenerator: (req: FastifyRequest) => rawRemoteAddress(req),
      errorResponseBuilder: (req: FastifyRequest, context: { statusCode: number }) => {
        recordStatusProbeOutcome('rate_limited')
        operationalLog(
          req.log,
          'warn',
          OperationalEvent.STATUS_PROBE_RATE_LIMITED,
          'status probe rate limited',
          {}
        )
        return {
          statusCode: context.statusCode,
          code: 'rate_limit_exceeded',
          message: 'Too many status probe requests',
        }
      },
    })
  }

  fastify.route({
    method: 'GET',
    url: '/status',
    schema: {
      response: {
        200: StatusResponseSchema,
        401: UnauthorizedResponseSchema,
        404: NotFoundResponseSchema,
        503: StatusResponseSchema,
      },
    },
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      // AC-7: never cache a health report — a stale 200 could mask a real outage or a stale 503
      // could mask recovery.
      reply.header('Cache-Control', 'no-store')

      const auth = await resolveStatusAuth(req)
      if (!auth.allowed) {
        // AC-6: both the "safe-default 404" and "wrong/missing/revoked token 401" branches count
        // as the same 'unauthorized' outcome for metrics purposes — the outcome label itself
        // must not leak which failure mode applied any more than the HTTP body does.
        recordStatusProbeOutcome('unauthorized')
        operationalLog(
          req.log,
          'warn',
          OperationalEvent.STATUS_PROBE_UNAUTHORIZED,
          'status probe unauthorized',
          { httpStatus: auth.status }
        )
        if (auth.status === 404) {
          return reply.status(404).send({ code: 'not_found', message: 'Not Found' })
        }
        return reply.status(401).send({ code: 'unauthorized', message: 'Unauthorized' })
      }
      if (auth.tokenId) {
        void touchOperationalStatusTokenLastUsed(auth.tokenId, req.log)
      }

      const checks = await runStatusChecks(options.dbPool, req.log)
      const status = deriveAggregateStatus(checks)
      const body = {
        status,
        // Story 9.10 AC-1: the same getReleaseVersion() source /health and OpenAPI
        // info.version use — never package.json's permanent 0.0.1 placeholder, which would
        // otherwise make this operational endpoint disagree with /health on the same instance.
        version: getReleaseVersion().version,
        timestamp: new Date().toISOString(),
        checks,
      }

      if (status === 'healthy') {
        recordStatusProbeOutcome('success')
        operationalLog(
          req.log,
          'info',
          OperationalEvent.STATUS_PROBE_SUCCESS,
          'status probe healthy',
          {}
        )
        return reply.send(body)
      }

      recordStatusProbeOutcome(status === 'degraded' ? 'degraded' : 'unavailable')
      operationalLog(
        req.log,
        'warn',
        status === 'degraded'
          ? OperationalEvent.STATUS_PROBE_DEGRADED
          : OperationalEvent.STATUS_PROBE_UNAVAILABLE,
        'status probe not healthy',
        { status, checks }
      )
      return reply.status(503).send(body)
    },
  })
}
