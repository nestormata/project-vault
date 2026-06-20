import type { FastifyRequest } from 'fastify/types/request.js'
import type { FastifyReply } from 'fastify/types/reply.js'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyApp } from '../lib/fastify-app.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf-8')) as {
  version: string
}

type DbPool = {
  query: (sql: string) => Promise<unknown>
}

export async function healthRoutes(
  fastify: FastifyApp,
  options: { dbPool?: DbPool }
): Promise<void> {
  fastify.get('/health', async (_req: FastifyRequest, reply: FastifyReply) => {
    return reply.send({ status: 'ok', version: pkg.version })
  })

  fastify.get('/ready', async (_req: FastifyRequest, reply: FastifyReply) => {
    if (!options.dbPool) {
      return reply.status(503).send({ status: 'unavailable', reason: 'db', retryAfter: 5 })
    }

    try {
      await options.dbPool.query('SELECT 1')
      return reply.send({ status: 'ready' })
    } catch {
      return reply.status(503).send({ status: 'unavailable', reason: 'db', retryAfter: 5 })
    }
  })
}
