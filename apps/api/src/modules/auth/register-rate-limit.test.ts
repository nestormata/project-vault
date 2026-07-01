import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  configureAuthIntegrationEnv,
  initVaultForTest,
} from '../../__tests__/helpers/auth-test-helpers.js'

configureAuthIntegrationEnv()

const { createApp } = await import('../../app.js')
const { initVault } = await import('../vault/key-service.js')
const { resetVaultForTest } = await import('../../__tests__/helpers/vault-test-cleanup.js')

const TEST_PASSPHRASE = 'register-rate-limit-tests-passphrase'
const PASSWORD = 'correct-horse-battery-staple'
const REGISTER_URL = '/api/v1/auth/register'

describe('POST /register rate limiting', () => {
  beforeAll(async () => {
    await resetVaultForTest()
    await initVaultForTest(initVault, TEST_PASSPHRASE)
  })

  afterAll(async () => {
    await resetVaultForTest()
  })

  it('returns 429 rate_limit_exceeded (not a 500) once the per-route limit is exceeded', async () => {
    const app = await createApp({ logger: false })

    // The /register route caps at 10 requests/minute (routes.ts). The 11th request in the
    // same window must be rejected with 429, not fall through to an unhandled 500 — see
    // AGENTS.md TDD note: this reproduces the CI flake where dashboard-stats.test.ts calls
    // registerOwner() 11 times against a single app instance.
    let lastResponse: Awaited<ReturnType<typeof app.inject>> | undefined
    for (let i = 0; i < 11; i += 1) {
      lastResponse = await app.inject({
        method: 'POST',
        url: REGISTER_URL,
        payload: {
          email: `register-rate-limit-${i}-${randomUUID()}@example.com`,
          password: PASSWORD,
          orgName: `Register Rate Limit ${i} ${randomUUID()}`,
        },
      })
    }

    expect(lastResponse?.statusCode).toBe(429)
    expect(lastResponse?.json()).toMatchObject({
      code: 'rate_limit_exceeded',
      message: 'Too many authentication attempts',
    })

    await app.close()
  }, 30_000)
})
