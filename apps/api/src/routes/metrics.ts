import type { FastifyRequest } from 'fastify/types/request.js'
import type { FastifyReply } from 'fastify/types/reply.js'
import { collectDefaultMetrics, register, Counter, Histogram, Gauge } from 'prom-client'
import type { FastifyApp } from '../lib/fastify-app.js'
import { dbPoolConnectionsActive } from '../lib/db-pool-metrics.js'
import { getVaultStatus } from '../modules/vault/key-service.js'

collectDefaultMetrics()

export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
})

export const httpRequestDurationSeconds = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
})

export const processUptimeSeconds = new Gauge({
  name: 'process_uptime_seconds',
  help: 'Process uptime in seconds',
  collect() {
    this.set(process.uptime())
  },
})

export const vaultSealed = new Gauge({
  name: 'vault_sealed',
  help: '1 if vault is sealed or uninitialized, 0 if unsealed',
  collect() {
    this.set(getVaultStatus() !== 'unsealed' ? 1 : 0)
  },
})

// Keep an explicit module reference so this route module registers the Story 1.10
// DB gauge even when no instrumented pool has issued a query yet.
void dbPoolConnectionsActive

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
    httpRequestDurationSeconds.observe(
      {
        method: req.method,
        route,
        status_code: String(reply.statusCode),
      },
      reply.elapsedTime / 1000
    )
    done()
  })
}
