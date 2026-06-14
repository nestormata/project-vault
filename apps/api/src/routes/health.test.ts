import { describe, it, expect, vi } from 'vitest'
import { createApp } from '../app.js'

vi.mock('../config/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    API_PORT: 3000,
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
    METRICS_BIND_HOST: '127.0.0.1',
    LOG_LEVEL: 'silent',
  },
}))

describe('GET /health', () => {
  it('returns 200 with status ok and version', async () => {
    const app = await createApp({ logger: false })

    const response = await app.inject({
      method: 'GET',
      url: '/health',
    })

    expect(response.statusCode).toBe(200)
    const body = response.json<{ status: string; version: string }>()
    expect(body.status).toBe('ok')
    expect(typeof body.version).toBe('string')
    await app.close()
  })
})

describe('GET /ready', () => {
  it('returns 200 when DB pool resolves', async () => {
    const mockDbPool = {
      query: vi.fn().mockResolvedValue([]),
    }
    const app = await createApp({ logger: false, dbPool: mockDbPool })
    const response = await app.inject({ method: 'GET', url: '/ready' })

    expect(response.statusCode).toBe(200)
    expect(response.json<{ status: string }>().status).toBe('ready')
    await app.close()
  })

  it('returns 503 when DB pool rejects', async () => {
    const mockDbPool = {
      query: vi.fn().mockRejectedValue(new Error('Connection refused')),
    }
    const app = await createApp({ logger: false, dbPool: mockDbPool })
    const response = await app.inject({ method: 'GET', url: '/ready' })

    expect(response.statusCode).toBe(503)
    const body = response.json<{ status: string; reason: string }>()
    expect(body.status).toBe('unavailable')
    expect(body.reason).toBe('db')
    await app.close()
  })

  it('returns 503 when no DB pool configured', async () => {
    const app = await createApp({ logger: false })
    const response = await app.inject({ method: 'GET', url: '/ready' })

    expect(response.statusCode).toBe(503)
    expect(response.json<{ status: string }>().status).toBe('unavailable')
    await app.close()
  })
})
