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

async function registerN(app: Awaited<ReturnType<typeof createApp>>, count: number) {
  const responses: Awaited<ReturnType<typeof app.inject>>[] = []
  for (let i = 0; i < count; i += 1) {
    responses.push(
      await app.inject({
        method: 'POST',
        url: REGISTER_URL,
        payload: {
          email: `register-rate-limit-${i}-${randomUUID()}@example.com`,
          password: PASSWORD,
          orgName: `Register Rate Limit ${i} ${randomUUID()}`,
        },
      })
    )
  }
  return responses
}

describe('POST /register rate limiting', () => {
  beforeAll(async () => {
    await resetVaultForTest()
    await initVaultForTest(initVault, TEST_PASSPHRASE)
  })

  afterAll(async () => {
    await resetVaultForTest()
  })

  it('does not rate-limit registration under NODE_ENV=test by default', async () => {
    // Real integration suites (e.g. dashboard-stats.test.ts) register many users as pure
    // fixture setup against one shared app instance. Rate limiting is bypassed here by
    // default (route-helpers.ts, isRateLimitEnforced) precisely so that behavior stays
    // deterministic regardless of how fast the suite happens to execute — see the CI flake
    // this file exists to cover: the 11th registerOwner() call intermittently hit the real
    // /register limiter (429) whenever a run was fast enough to pack 11 calls into 60s.
    const app = await createApp({ logger: false })
    try {
      const responses = await registerN(app, 15)
      for (const res of responses) expect(res.statusCode).toBe(201)
    } finally {
      await app.close()
    }
  }, 30_000)

  it('returns 429 rate_limit_exceeded (not a 500) once the per-route limit is exceeded when explicitly enforced', async () => {
    process.env['RATE_LIMIT_TEST_ENFORCE'] = 'true'
    const app = await createApp({ logger: false })

    try {
      // The /register route caps at 10 requests/minute (routes.ts). The 11th request in the
      // same window must be rejected with 429, not fall through to an unhandled 500.
      const responses = await registerN(app, 11)
      const lastResponse = responses.at(-1)

      expect(lastResponse?.statusCode).toBe(429)
      expect(lastResponse?.json()).toMatchObject({
        code: 'rate_limit_exceeded',
        message: 'Too many authentication attempts',
      })
    } finally {
      await app.close()
      delete process.env['RATE_LIMIT_TEST_ENFORCE']
    }
  }, 30_000)
})
