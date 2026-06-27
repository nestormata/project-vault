import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import { describe, it, expect, vi } from 'vitest'
import { createApp } from '../app.js'
import { metricsRoutes } from './metrics.js'

vi.mock('../config/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    API_PORT: 3001,
    DATABASE_URL: 'postgresql://metrics-test:test@localhost:5432/test_metrics',
    CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
    METRICS_BIND_HOST: '127.0.0.1',
    LOG_LEVEL: 'silent',
    SERVICE_NAME: 'api',
    TRUST_PROXY: false,
    TRUST_PROXY_HOPS: 1,
  },
}))

function responseText(response: unknown): string {
  const typed = response as { body?: string; payload?: string }
  return typed.body ?? typed.payload ?? ''
}

describe('GET /metrics', () => {
  it('returns 200 with valid Prometheus content-type for localhost', async () => {
    const app = await createApp({ logger: false, metricsBindHost: '127.0.0.1' })

    const response = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { host: '127.0.0.1' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/plain')
    await app.close()
  })

  it('returns 200 for localhost requests', async () => {
    const app = await createApp({ logger: false, metricsBindHost: '127.0.0.1' })

    const response = await app.inject({
      method: 'GET',
      url: '/metrics',
    })

    expect(response.statusCode).toBe(200)
    await app.close()
  })

  it('returns 403 for non-loopback requests with default config', async () => {
    const app = await createApp({ logger: false, metricsBindHost: '127.0.0.1' })

    const response = await app.inject({
      method: 'GET',
      url: '/metrics',
      remoteAddress: '10.0.0.8',
    })

    expect(response.statusCode).toBe(403)
    await app.close()
  })

  it('returns the Story 1.10 required metric names', async () => {
    const app = await createApp({ logger: false, metricsBindHost: '127.0.0.1' })

    await app.inject({ method: 'GET', url: '/health' })
    const response = await app.inject({ method: 'GET', url: '/metrics' })
    const body = responseText(response)

    expect(response.statusCode).toBe(200)
    expect(body).toContain('process_uptime_seconds')
    expect(body).toContain('http_requests_total')
    expect(body).toContain('http_request_duration_seconds')
    expect(body).toContain('vault_sealed')
    expect(body).toContain('db_pool_connections_active')
    expect(body).not.toContain('http_request_duration_ms')
    await app.close()
  })

  it('uses the Story 1.10 seconds histogram buckets', async () => {
    const app = await createApp({ logger: false, metricsBindHost: '127.0.0.1' })

    await app.inject({ method: 'GET', url: '/health' })
    const response = await app.inject({ method: 'GET', url: '/metrics' })
    const body = responseText(response)

    expect(body).toContain('http_request_duration_seconds_bucket')
    for (const bucket of ['0.005', '0.01', '0.025', '0.05', '0.1', '0.25', '0.5', '1', '2.5']) {
      expect(body).toContain(`le="${bucket}"`)
    }
    await app.close()
  })

  it('records HTTP metrics for non-metrics routes', async () => {
    const app = await createApp({ logger: false, metricsBindHost: '127.0.0.1' })

    await app.inject({ method: 'GET', url: '/health' })
    const response = await app.inject({ method: 'GET', url: '/metrics' })
    const body = responseText(response)

    expect(body).toContain('route="/health"')
    expect(body).toContain('http_request_duration_seconds_bucket')
    await app.close()
  })

  it('uses __unknown__ rather than raw URLs for unmatched routes', async () => {
    const app = await createApp({ logger: false, metricsBindHost: '127.0.0.1' })
    const uniquePath = `/missing/${randomUUID()}?token=raw-query-secret`

    await app.inject({ method: 'GET', url: uniquePath })
    const response = await app.inject({ method: 'GET', url: '/metrics' })
    const body = responseText(response)

    expect(body).toContain('route="__unknown__"')
    expect(body).not.toContain(uniquePath)
    expect(body).not.toContain('raw-query-secret')
    await app.close()
  })

  it('does not trust X-Forwarded-For for loopback authorization', async () => {
    const app = Fastify({ trustProxy: 1 })
    await metricsRoutes(app as never, { metricsBindHost: '127.0.0.1' })

    const response = await app.inject({
      method: 'GET',
      url: '/metrics',
      remoteAddress: '10.0.0.8',
      headers: { 'x-forwarded-for': '127.0.0.1' },
    })

    expect(response.statusCode).toBe(403)
    await app.close()
  })
})
