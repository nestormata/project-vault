import { beforeEach, describe, expect, it, vi } from 'vitest'

const BASE_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://vault_app:secret@localhost:5432/project_vault',
  CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
  LOG_LEVEL: 'fatal',
}

describe('authenticate plugin', () => {
  beforeEach(() => {
    process.env = { ...process.env, ...BASE_ENV }
    vi.resetModules()
  })

  it('rejects /auth/me without an access token cookie', async () => {
    const { createApp } = await import('../app.js')
    const app = await createApp({ logger: false })
    const res = await app.inject({ method: 'GET', url: '/api/v1/auth/me' })

    expect(res.statusCode).toBe(401)
    expect(res.json()).toMatchObject({
      code: 'access_token_missing',
    })

    await app.close()
  })
})
