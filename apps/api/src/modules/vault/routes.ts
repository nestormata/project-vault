import type { FastifyRequest } from 'fastify/types/request.js'
import type { FastifyReply } from 'fastify/types/reply.js'
import rateLimit from '@fastify/rate-limit'
import { OperationalEvent } from '@project-vault/shared'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { AppError } from '../../lib/errors.js'
import { isRateLimitEnforced } from '../../lib/route-helpers.js'
import { initVault, unsealVault } from './key-service.js'
import {
  VaultInitRequestSchema,
  VaultUnsealRequestSchema,
  VaultInitResponseSchema,
  VaultUnsealResponseSchema,
  VaultErrorResponseSchema,
} from './schema.js'
import { redactBodyForLog } from '../../plugins/redact-secrets.js'

export async function vaultRoutes(fastify: FastifyApp): Promise<void> {
  fastify.route({
    method: 'POST',
    url: '/api/v1/vault/init',
    schema: {
      tags: ['vault'],
      response: {
        200: VaultInitResponseSchema,
        400: VaultErrorResponseSchema,
        403: VaultErrorResponseSchema,
        409: VaultErrorResponseSchema,
      },
    },
    // Exempt from rate limiting: init is protected by the bootstrap-token gate
    // instead (AC-23). The rate-limit plugin's config.rateLimit: false opts a route
    // out when the plugin is registered globally in the encapsulation context.
    config: { rateLimit: false },
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = VaultInitRequestSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: 'validation_error', message: parsed.error.message })
      }
      try {
        const result = await initVault(
          parsed.data,
          req.headers as Record<string, string | string[] | undefined>
        )
        req.log.info(
          {
            eventType: OperationalEvent.VAULT_INIT,
            keyVersion: result.keyVersion,
            kmsType: result.kmsType,
            body: redactBodyForLog(req.body),
          },
          'Vault initialized successfully'
        )
        return reply.status(200).send(result)
      } catch (err) {
        if (err instanceof AppError) {
          req.log.warn(
            { eventType: OperationalEvent.VAULT_INIT_FAILED, error: err.code },
            'Vault init failed'
          )
          return reply
            .status(err.statusCode)
            .send({ error: err.code.toLowerCase(), message: err.message })
        }
        throw err
      }
    },
  })

  // Scope rate limiting to this encapsulation context (vaultRoutes only), applying
  // to all routes here except those explicitly opted out via config.rateLimit: false
  // (the /vault/init route above). AC-24 requires rate limiting ONLY on unseal.
  // Note: @fastify/rate-limit v10's errorResponseBuilder has a status-code regression
  // when used with per-route config; the 429 response body shape is handled in app.ts's
  // global setErrorHandler instead (where the rate-limit error correctly carries statusCode 429).
  // Skipped under NODE_ENV=test by default — see isRateLimitEnforced in route-helpers.ts.
  if (isRateLimitEnforced()) {
    await fastify.register(rateLimit, {
      max: 5,
      timeWindow: '1 minute',
      keyGenerator: (req: FastifyRequest) => req.ip,
    })
  }

  fastify.route({
    method: 'POST',
    url: '/api/v1/vault/unseal',
    schema: {
      tags: ['vault'],
      response: {
        200: VaultUnsealResponseSchema,
        400: VaultErrorResponseSchema,
        401: VaultErrorResponseSchema,
        503: VaultErrorResponseSchema,
      },
    },
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = VaultUnsealRequestSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: 'validation_error', message: parsed.error.message })
      }
      try {
        const result = await unsealVault(parsed.data)
        req.log.info(
          {
            eventType: OperationalEvent.VAULT_UNSEAL,
            keyVersion: result.keyVersion,
            kmsType: result.kmsType,
            body: redactBodyForLog(req.body),
          },
          'Vault unsealed successfully'
        )
        return reply.status(200).send(result)
      } catch (err) {
        if (err instanceof AppError) {
          req.log.warn(
            { eventType: OperationalEvent.VAULT_UNSEAL_FAILED, error: err.code },
            'Vault unseal failed'
          )
          return reply
            .status(err.statusCode)
            .send({ error: err.code.toLowerCase(), message: err.message })
        }
        throw err
      }
    },
  })
}
