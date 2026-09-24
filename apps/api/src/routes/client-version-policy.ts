import rateLimit from '@fastify/rate-limit'
import type { FastifyRequest } from 'fastify/types/request.js'
import type { FastifyReply } from 'fastify/types/reply.js'
import { z } from 'zod/v4'
import type { FastifyApp } from '../lib/fastify-app.js'
import { getReleaseVersion } from '../lib/package-version.js'
import { isRateLimitEnforced } from '../lib/route-helpers.js'
import {
  buildClientVersionPolicyData,
  type EffectiveCliVersionPolicy,
} from '../modules/client-versions/policy.js'

/**
 * Story 43.6 (decision D3) — `GET /api/v1/client-version-policy`: the public, static policy the
 * `pvault` CLI checks at startup (minimum supported, withdrawn versions, and the server's own
 * release as `current`). Deliberately separate from `/health` (whose liveness contract and payload
 * stay unchanged) and not vault-guard-allowlisted: a sealed server answers 503, which the CLI
 * treats as unreachable.
 *
 * Unauthenticated, zero DB reads, no tenant data: the body is a pure function of the boot-resolved
 * policy and `RELEASE_VERSION`, identical for every caller. No audit (no actor, no tenant, no
 * mutation) and no metric labelled by client version. The per-client `clients` map lets a later
 * client (the browser extension) add its own key without a new route.
 */
export const CLIENT_VERSION_POLICY_PATH = '/api/v1/client-version-policy'
const RATE_LIMIT_PER_MINUTE = 60

const SemverOrNull = z.string().nullable()

const ClientVersionPolicyResponseSchema = z.object({
  data: z.object({
    schemaVersion: z.literal(1),
    server: z.object({
      version: z.string(),
      versionSource: z.enum(['release', 'development']),
    }),
    clients: z.object({
      cli: z.object({
        current: SemverOrNull,
        minimumSupported: SemverOrNull,
        withdrawn: z.array(z.object({ version: z.string(), reason: z.string() })),
      }),
    }),
  }),
})

export async function clientVersionPolicyRoutes(
  fastify: FastifyApp,
  options: { policy: EffectiveCliVersionPolicy }
): Promise<void> {
  // Encapsulated in this plugin (like routes/status.ts). A NAT-shared IP that exceeds it only
  // loses notices: the CLI treats 429 as unreachable and proceeds.
  if (isRateLimitEnforced()) {
    await fastify.register(rateLimit, {
      max: RATE_LIMIT_PER_MINUTE,
      timeWindow: '1 minute',
      keyGenerator: (req: FastifyRequest) => req.ip,
      errorResponseBuilder: (_req: FastifyRequest, context: { statusCode: number }) => ({
        statusCode: context.statusCode,
        code: 'rate_limit_exceeded',
        message: 'Too many client version policy requests',
      }),
    })
  }

  fastify.route({
    method: 'GET',
    url: CLIENT_VERSION_POLICY_PATH,
    schema: { response: { 200: ClientVersionPolicyResponseSchema } },
    handler: async (_req: FastifyRequest, reply: FastifyReply) => {
      // Read per request, like /health, so the reported release always matches the process.
      const data = buildClientVersionPolicyData(options.policy, getReleaseVersion())
      return reply.header('cache-control', 'public, max-age=300').send({ data })
    },
  })
}
