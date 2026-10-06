import fp from 'fastify-plugin'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { OperationalEvent } from '@project-vault/shared'

const MAX_LOGGED_URL_LENGTH = 256

function structuredLogging(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('onRequest', (request: FastifyRequest, reply: FastifyReply, done: () => void) => {
    request.log = request.log.child({ traceId: request.id })
    reply.header('X-Request-ID', request.id)
    done()
  })

  fastify.addHook(
    'onResponse',
    (request: FastifyRequest, reply: FastifyReply, done: () => void) => {
      const url = String(request.routeOptions?.url ?? request.url).slice(0, MAX_LOGGED_URL_LENGTH)
      request.log.info(
        {
          eventType: OperationalEvent.HTTP_REQUEST,
          method: request.method,
          url,
          statusCode: reply.statusCode,
          responseTimeMs: reply.elapsedTime,
        },
        'request completed'
      )
      done()
    }
  )
  return Promise.resolve()
}

export const structuredLoggingPlugin = fp(structuredLogging, { name: 'structured-logging' })
