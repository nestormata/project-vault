import { randomUUID } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import { ApiErrorSchema } from '../../lib/api-contracts.js'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { secureRoute } from '../../lib/secure-route.js'
import { env } from '../../config/env.js'
import type { MachineJwtClaims } from '../../plugins/machine-jwt.js'
import { apiKeysMatch, hashApiKey } from './tokens.js'
import { extractBearerToken } from './bearer-token.js'
import {
  findApiKeyByHash,
  isApiKeyValidForExchange,
  touchApiKeyLastUsed,
} from './token-exchange-lookup.js'
import { isKeyHashRateLimited, recordFailedKeyHashAttempt } from './token-exchange-rate-limit.js'
import { MachineTokenResponseSchema } from './token-exchange-schema.js'
import { checkRotationAnomaly } from './rotation.js'

const API_KEY_PREFIX = 'pk_'

const ACCESS_TOKEN_MISSING = {
  code: 'access_token_missing',
  message: 'Access token is missing',
} as const
const INVALID_API_KEY = {
  code: 'invalid_api_key',
  message: 'API key is invalid',
} as const
const KEY_HASH_RATE_LIMITED = {
  code: 'rate_limit_exceeded',
  message: 'Too many failed attempts for this API key',
} as const

type MachineJwtSignFastify = {
  machineJwtSign: (claims: MachineJwtClaims) => Promise<string>
}

// AC-4: IP-based bucket is enforced automatically by SecureRoute's public-route path
// (`handlePublicRequest` keys by `ip:${request.ip}`) via this `rateLimit` config — this is the
// per-IP budget, distinct from the per-key-hash budget enforced manually inside the handler.
const IP_RATE_LIMIT = { max: 20, timeWindowMs: 60_000, key: 'POST /api/v1/auth/machine-token' }

export async function machineTokenExchangeRoutes(fastify: FastifyApp): Promise<void> {
  secureRoute(fastify, {
    method: 'POST',
    url: '/machine-token',
    schema: {
      response: {
        200: MachineTokenResponseSchema,
        401: ApiErrorSchema,
        429: ApiErrorSchema,
      },
    },
    security: {
      requireAuth: false,
      writeAuditEvent: false,
      rateLimit: IP_RATE_LIMIT,
    },
    handler: async (_ctx, req: FastifyRequest, reply) => {
      const token = extractBearerToken(req)
      if (!token) return reply.status(401).send(ACCESS_TOKEN_MISSING)
      // AC-3: cheap, pre-DB rejection — no query is made for a key that fails the prefix check.
      if (!token.startsWith(API_KEY_PREFIX)) return reply.status(401).send(INVALID_API_KEY)

      const keyHash = hashApiKey(token)
      if (isKeyHashRateLimited(keyHash)) {
        return reply.status(429).send(KEY_HASH_RATE_LIMITED)
      }

      const row = await findApiKeyByHash(keyHash)
      const valid =
        row !== null && apiKeysMatch(row.keyHash, token) && isApiKeyValidForExchange(row)
      if (!row || !valid) {
        recordFailedKeyHashAttempt(keyHash)
        // AC-3: identical response body regardless of *why* the key failed — never-issued,
        // revoked, expired, or deactivated-owner all look the same to an unauthenticated caller.
        return reply.status(401).send(INVALID_API_KEY)
      }

      const now = new Date()
      await touchApiKeyLastUsed(row.id, now)

      // AC-19: purely detective, never preventive — a failure here must never block the
      // exchange that's already succeeded (e.g. no admin recipient configured for the org yet).
      try {
        await checkRotationAnomaly(row.orgId, {
          oldKeyId: row.id,
          machineUserId: row.machineUserId,
          usedAt: now,
        })
      } catch (error) {
        req.log.warn({
          eventType: 'machine_token.rotation_anomaly_check_failed',
          keyId: row.id,
          err: error,
        })
      }

      const jti = randomUUID()
      const accessToken = await (fastify as unknown as MachineJwtSignFastify).machineJwtSign({
        sub: row.machineUserId,
        orgId: row.orgId,
        scope: row.projectId,
        keyId: row.id,
        jti,
      })

      return {
        data: {
          accessToken,
          tokenType: 'Bearer' as const,
          expiresIn: env.MACHINE_JWT_TTL_SECONDS,
        },
      }
    },
  })
}
