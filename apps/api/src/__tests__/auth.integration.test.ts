import { describe, expect, it } from 'vitest'
import { createApp } from '../app.js'

describe('Auth integration guards', () => {
  it('rejects non-ASCII register email with ASCII-specific validation detail', async () => {
    const app = await createApp({ logger: false })
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: 'аdmin@test.com',
        password: 'twelve-characters',
        orgName: 'Test',
      },
    })

    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({
      code: 'validation_error',
      details: { email: ['ASCII characters only'] },
    })
    await app.close()
  })

  it('rejects oversized refresh cookies before token lookup', async () => {
    const app = await createApp({ logger: false })
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: `refresh-token=${'x'.repeat(129)}` },
    })

    expect(res.statusCode).toBe(401)
    expect(res.json()).toMatchObject({ code: 'refresh_token_invalid' })
    await app.close()
  })
})
