import { beforeAll, describe, expect, it, vi } from 'vitest'

let createApp: typeof import('../../app.js').createApp

describe('auth routes', () => {
  beforeAll(async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://vault_app:secret@localhost:5432/project_vault')
    createApp = (await import('../../app.js')).createApp
  })

  it('registers auth routes as POST-only with 405 for GET', async () => {
    const app = await createApp({ logger: false })
    const login = await app.inject({ method: 'GET', url: '/api/v1/auth/login' })
    const refresh = await app.inject({ method: 'GET', url: '/api/v1/auth/refresh' })
    const enroll = await app.inject({ method: 'GET', url: '/api/v1/auth/mfa/enroll' })
    const recover = await app.inject({ method: 'GET', url: '/api/v1/auth/mfa/recover' })

    expect(login.statusCode).toBe(405)
    expect(login.headers['allow']).toBe('POST')
    expect(refresh.statusCode).toBe(405)
    expect(refresh.headers['allow']).toBe('POST')
    expect(enroll.statusCode).toBe(405)
    expect(enroll.headers['allow']).toBe('POST')
    expect(recover.statusCode).toBe(405)
    expect(recover.headers['allow']).toBe('POST')

    await app.close()
  })

  it('protects MFA enrollment routes with access-token auth', async () => {
    const app = await createApp({ logger: false })

    const enroll = await app.inject({ method: 'POST', url: '/api/v1/auth/mfa/enroll', payload: {} })
    const verify = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/verify-enrollment',
      payload: { totp: '123456' },
    })
    const regenerate = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/regenerate-recovery-codes',
      payload: { totp: '123456' },
    })

    expect(enroll.statusCode).toBe(401)
    expect(verify.statusCode).toBe(401)
    expect(regenerate.statusCode).toBe(401)

    await app.close()
  })

  it('keeps MFA recover public while validating malformed bodies', async () => {
    const app = await createApp({ logger: false })

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/recover',
      payload: { email: 'not-an-email', password: 'short', recoveryCode: 'bad' },
    })

    expect(response.statusCode).toBe(422)

    await app.close()
  })
})
