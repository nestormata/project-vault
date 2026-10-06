import fp from 'fastify-plugin'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { observeHttpMetrics } from '../routes/metrics.js'

function httpMetrics(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('onResponse', (req: FastifyRequest, reply: FastifyReply, done: () => void) => {
    observeHttpMetrics(req, reply)
    done()
  })
  return Promise.resolve()
}

export const httpMetricsPlugin = fp(httpMetrics, { name: 'http-metrics' })
