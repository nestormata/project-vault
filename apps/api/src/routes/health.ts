import type { FastifyRequest } from 'fastify/types/request.js'
import type { FastifyReply } from 'fastify/types/reply.js'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OperationalEvent } from '@project-vault/shared'
import type { FastifyApp } from '../lib/fastify-app.js'
import { getVaultStatus } from '../modules/vault/key-service.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf-8')) as {
  version: string
}

type DbPool = {
  query: (sql: string) => Promise<unknown>
}

function serializeError(err: unknown): { message: string; name?: string; stack?: string } {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack }
  }
  return { message: String(err) }
}

export async function healthRoutes(
  fastify: FastifyApp,
  options: { dbPool?: DbPool }
): Promise<void> {
  fastify.get('/health', async (_req: FastifyRequest, reply: FastifyReply) => {
    return reply.send({ status: 'ok', version: pkg.version })
  })

  fastify.get('/ready', async (req: FastifyRequest, reply: FastifyReply) => {
    const vaultStatus = getVaultStatus()

    if (vaultStatus === 'uninitialized') {
      return reply.status(503).send({
        status: 'unavailable',
        reason: 'uninitialized',
        message: 'Vault not initialized. POST /api/v1/vault/init to initialize.',
      })
    }

    if (vaultStatus === 'sealed') {
      return reply.status(503).send({
        status: 'unavailable',
        reason: 'sealed',
        message: 'Manual unseal required via POST /api/v1/vault/unseal',
      })
    }

    if (!options.dbPool) {
      return reply.status(503).send({ status: 'unavailable', reason: 'db', retryAfter: 5 })
    }

    try {
      await options.dbPool.query('SELECT 1')
      return reply.send({ status: 'ready' })
    } catch (err) {
      req.log.error(
        { eventType: OperationalEvent.DB_ERROR, err: serializeError(err) },
        'Database query failed'
      )
      return reply.status(503).send({ status: 'unavailable', reason: 'db', retryAfter: 5 })
    }
  })
}
