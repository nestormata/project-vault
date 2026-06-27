import { describe, expect, it } from 'vitest'
import { createApp } from '../../app.js'

describe('auth routes', () => {
  it('registers auth routes as POST-only with 405 for GET', async () => {
    const app = await createApp({ logger: false })
    const login = await app.inject({ method: 'GET', url: '/api/v1/auth/login' })
    const refresh = await app.inject({ method: 'GET', url: '/api/v1/auth/refresh' })

    expect(login.statusCode).toBe(405)
    expect(login.headers['allow']).toBe('POST')
    expect(refresh.statusCode).toBe(405)
    expect(refresh.headers['allow']).toBe('POST')

    await app.close()
  })
})
