import type { FastifyRequest } from 'fastify/types/request.js'
import type { FastifyReply } from 'fastify/types/reply.js'
import rateLimit from '@fastify/rate-limit'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { AppError } from '../../lib/errors.js'
import { initVault, unsealVault } from './key-service.js'
import { VaultInitRequestSchema, VaultUnsealRequestSchema } from './schema.js'
import { redactBodyForLog } from '../../plugins/redact-secrets.js'

export async function vaultRoutes(fastify: FastifyApp): Promise<void> {
  fastify.route({
    method: 'POST',
    url: '/api/v1/vault/init',
    schema: { tags: ['vault'] },
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
            event: 'vault.init',
            keyVersion: result.keyVersion,
            kmsType: result.kmsType,
            body: redactBodyForLog(req.body),
          },
          'Vault initialized successfully'
        )
        return reply.status(200).send(result)
      } catch (err) {
        if (err instanceof AppError) {
          req.log.warn({ event: 'vault.init.failed', error: err.code }, 'Vault init failed')
          return reply
            .status(err.statusCode)
            .send({ error: err.code.toLowerCase(), message: err.message })
        }
        throw err
      }
    },
  })

  await fastify.register(rateLimit, {
    max: 5,
    timeWindow: '1 minute',
    hook: 'preHandler',
    keyGenerator: (req: FastifyRequest) => req.ip,
    errorResponseBuilder: (_req: FastifyRequest, context: { ttl: number }) => ({
      error: 'rate_limited',
      message: 'Too many unseal attempts',
      retryAfter: Math.ceil(context.ttl / 1000),
    }),
  })

  fastify.route({
    method: 'POST',
    url: '/api/v1/vault/unseal',
    schema: { tags: ['vault'] },
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = VaultUnsealRequestSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: 'validation_error', message: parsed.error.message })
      }
      try {
        const result = await unsealVault(parsed.data)
        req.log.info(
          {
            event: 'vault.unseal',
            keyVersion: result.keyVersion,
            kmsType: result.kmsType,
            body: redactBodyForLog(req.body),
          },
          'Vault unsealed successfully'
        )
        return reply.status(200).send(result)
      } catch (err) {
        if (err instanceof AppError) {
          req.log.warn({ event: 'vault.unseal.failed', error: err.code }, 'Vault unseal failed')
          return reply
            .status(err.statusCode)
            .send({ error: err.code.toLowerCase(), message: err.message })
        }
        throw err
      }
    },
  })
}
