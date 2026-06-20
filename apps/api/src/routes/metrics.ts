import type { FastifyRequest } from 'fastify/types/request.js'
import type { FastifyReply } from 'fastify/types/reply.js'
import { collectDefaultMetrics, register, Counter, Histogram, Gauge } from 'prom-client'
import type { FastifyApp } from '../lib/fastify-app.js'

collectDefaultMetrics()

export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
})

export const httpRequestDurationMs = new Histogram({
  name: 'http_request_duration_ms',
  help: 'HTTP request duration in milliseconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [1, 5, 15, 50, 100, 500, 1000, 5000],
})

export const processUptimeSeconds = new Gauge({
  name: 'process_uptime_seconds',
  help: 'Process uptime in seconds',
  collect() {
    this.set(process.uptime())
  },
})

function isLoopbackRemoteAddress(remoteAddress: string): boolean {
  return (
    remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1'
  )
}

export async function metricsRoutes(
  fastify: FastifyApp,
  options: { metricsBindHost: string }
): Promise<void> {
  fastify.get('/metrics', async (req: FastifyRequest, reply: FastifyReply) => {
    if (options.metricsBindHost !== '0.0.0.0' && !isLoopbackRemoteAddress(req.ip)) {
      return reply.status(403).send({ error: 'Forbidden' })
    }

    const metrics = await register.metrics()
    return reply.header('Content-Type', register.contentType).send(metrics)
  })

  fastify.addHook('onResponse', (req: FastifyRequest, reply: FastifyReply, done: () => void) => {
    const route = req.routeOptions?.url ?? req.url
    httpRequestsTotal.inc({
      method: req.method,
      route,
      status_code: String(reply.statusCode),
    })
    done()
  })
}
