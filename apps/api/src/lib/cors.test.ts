import { describe, it, expect, vi } from 'vitest'
import { createApp } from '../app.js'

const ALLOWED_ORIGIN = 'http://localhost:5173'

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

describe('CORS', () => {
  it('rejects requests from an unlisted origin', async () => {
    const app = await createApp({ logger: false })

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/health',
        headers: { origin: 'http://evil.example.com' },
      })

      expect(response.statusCode).toBe(500)
      // Story 1.5 AC-15: the global error handler masks unexpected error messages
      // to avoid leaking internal details — only AppError/validation messages pass through.
      expect(response.json<{ error: string; message: string }>().error).toBe('internal_error')
    } finally {
      await app.close()
    }
  })

  it('allows requests from an allow-listed origin', async () => {
    const app = await createApp({ logger: false })

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/health',
        headers: { origin: ALLOWED_ORIGIN },
      })

      expect(response.statusCode).toBe(200)
      expect(response.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN)
    } finally {
      await app.close()
    }
  })
})
