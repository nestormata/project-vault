// Platform-operator-scoped (instance-wide). Do NOT confuse with apps/api/src/modules/admin/
// (org-scoped org-admin routes under the same /admin/ URL prefix — see Story 9.2 D2).
import type { FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod/v4'
import type { FastifyApp } from '../../lib/fastify-app.js'
import {
  secureRoute,
  type PublicRouteContext,
  type SecureRouteContext,
} from '../../lib/secure-route.js'
import type { DbPool } from '../status/service.js'
import {
  getStatusTokenMetadata,
  generateStatusToken,
  rotateStatusToken,
  revokeStatusToken,
  runStatusTokenTest,
  NoActiveStatusTokenError,
} from './status-token-service.js'
import {
  PLATFORM_ADMIN_ERROR_RESPONSES,
  PLATFORM_ADMIN_TAGS,
  sendPlatformAuditWriteFailure,
} from './route-common.js'

const StatusTokenMetadataResponseSchema = z.object({
  configured: z.boolean(),
  createdAt: z.string().optional(),
  lastUsedAt: z.string().optional(),
})

// AC-6: the plaintext token is returned exactly once, in this response only — never persisted,
// never returned again by GET.
const StatusTokenSecretResponseSchema = z.object({
  token: z.string(),
  createdAt: z.string(),
})

// `status` values here must stay in sync with routes/status.ts's CheckResultSchema —
// both describe the same underlying CheckOutcome ('ok' | 'degraded' | 'unavailable' | 'skipped').
const StatusTokenCheckResultSchema = z.object({
  status: z.enum(['ok', 'degraded', 'unavailable', 'skipped']),
  reason: z.string().optional(),
})

const StatusTokenTestResponseSchema = z.object({
  status: z.enum(['healthy', 'degraded', 'unavailable']),
  checks: z.object({
    database: StatusTokenCheckResultSchema,
    vault: StatusTokenCheckResultSchema,
    disk: StatusTokenCheckResultSchema,
  }),
})

function asSecureCtx(ctx: SecureRouteContext | PublicRouteContext): SecureRouteContext {
  return ctx as SecureRouteContext
}

// generate and rotate use the exact same schema and try/catch/response shape — only the
// token-producing service function differs — so both are factored out here to keep the two
// secureRoute() calls from being flagged as clones.
const STATUS_TOKEN_SECRET_SCHEMA = {
  tags: PLATFORM_ADMIN_TAGS,
  response: {
    200: StatusTokenSecretResponseSchema,
    ...PLATFORM_ADMIN_ERROR_RESPONSES,
  },
}

function newTokenHandler(
  produceToken: (
    userId: string,
    req: FastifyRequest
  ) => Promise<{ plaintext: string; createdAt: string }>
) {
  return async (
    ctx: SecureRouteContext | PublicRouteContext,
    req: FastifyRequest,
    reply: FastifyReply
  ) => {
    const secureCtx = asSecureCtx(ctx)
    try {
      const { plaintext, createdAt } = await produceToken(secureCtx.auth.userId, req)
      return { token: plaintext, createdAt }
    } catch (error) {
      if (sendPlatformAuditWriteFailure(error, reply)) return reply
      throw error
    }
  }
}

/**
 * Story 1.19 AC-5/AC-6/AC-9: operator+MFA-gated CRUD for the GET /status bearer token, mounted
 * alongside settings-routes.ts under the same `/api/v1/admin` prefix. Every mutation uses the
 * exact same `security: {...}` inline-literal shape as settings-routes.ts/orgs-routes.ts
 * (platform-admin-route-audit.test.ts asserts on the literal source text — see route-common.ts).
 */
export async function statusTokenRoutes(
  fastify: FastifyApp,
  options: { dbPool?: DbPool }
): Promise<void> {
  secureRoute(fastify, {
    method: 'GET',
    url: '/settings/status-token',
    schema: {
      tags: PLATFORM_ADMIN_TAGS,
      response: {
        200: StatusTokenMetadataResponseSchema,
        ...PLATFORM_ADMIN_ERROR_RESPONSES,
      },
    },
    security: {
      requireOrgScope: false,
      requirePlatformOperator: true,
      requireMfa: true,
      writeAuditEvent: false,
    },
    handler: async () => getStatusTokenMetadata(),
  })

  secureRoute(fastify, {
    method: 'POST',
    url: '/settings/status-token/generate',
    schema: STATUS_TOKEN_SECRET_SCHEMA,
    security: {
      requireOrgScope: false,
      requirePlatformOperator: true,
      requireMfa: true,
      writeAuditEvent: false,
    },
    handler: newTokenHandler(generateStatusToken),
  })

  secureRoute(fastify, {
    method: 'POST',
    url: '/settings/status-token/rotate',
    schema: STATUS_TOKEN_SECRET_SCHEMA,
    security: {
      requireOrgScope: false,
      requirePlatformOperator: true,
      requireMfa: true,
      writeAuditEvent: false,
    },
    handler: newTokenHandler(rotateStatusToken),
  })

  secureRoute(fastify, {
    method: 'POST',
    url: '/settings/status-token/revoke',
    schema: {
      tags: PLATFORM_ADMIN_TAGS,
      response: {
        204: z.void(),
        409: z.object({ code: z.string(), message: z.string() }),
        ...PLATFORM_ADMIN_ERROR_RESPONSES,
      },
    },
    security: {
      requireOrgScope: false,
      requirePlatformOperator: true,
      requireMfa: true,
      writeAuditEvent: false,
    },
    handler: async (
      ctx: SecureRouteContext | PublicRouteContext,
      req: FastifyRequest,
      reply: FastifyReply
    ) => {
      const secureCtx = asSecureCtx(ctx)
      try {
        await revokeStatusToken(secureCtx.auth.userId, req)
        return reply.status(204).send()
      } catch (error) {
        if (error instanceof NoActiveStatusTokenError) {
          return reply
            .status(409)
            .send({ code: 'no_active_status_token', message: 'No active status token to revoke' })
        }
        if (sendPlatformAuditWriteFailure(error, reply)) return reply
        throw error
      }
    },
  })

  // AC-5: "Test" — runs the live check logic in-process and reports the result, without
  // requiring the operator to separately curl the endpoint with the token they just generated.
  // Adversarial review fix: explicitly scoped to the same 30/min budget GET /status itself uses
  // (routes/status.ts) rather than relying on secureRoute's generic 60/min default — this action
  // runs the same live DB/disk checks GET /status does, so a compromised/scripted operator
  // session shouldn't be able to hammer them any harder than an external prober could.
  secureRoute(fastify, {
    method: 'POST',
    url: '/settings/status-token/test',
    schema: {
      tags: PLATFORM_ADMIN_TAGS,
      response: {
        200: StatusTokenTestResponseSchema,
        ...PLATFORM_ADMIN_ERROR_RESPONSES,
      },
    },
    security: {
      requireOrgScope: false,
      requirePlatformOperator: true,
      requireMfa: true,
      writeAuditEvent: false,
      rateLimit: { max: 30, timeWindowMs: 60_000 },
    },
    handler: async (_ctx: SecureRouteContext | PublicRouteContext, req: FastifyRequest) =>
      runStatusTokenTest(options.dbPool, req.log),
  })
}
