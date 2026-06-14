import { describe, it, expect, vi } from 'vitest'
import { createApp } from '../app.js'

vi.mock('../config/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    API_PORT: 3001,
    DATABASE_URL: 'postgresql://metrics-test:test@localhost:5432/test_metrics',
    CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
    METRICS_BIND_HOST: '127.0.0.1',
    LOG_LEVEL: 'silent',
  },
}))

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
})
