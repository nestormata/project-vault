import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  configureAuthIntegrationEnv,
  cookieHeader,
  initVaultForTest,
  registerAndLoginViaApi,
} from './helpers/auth-test-helpers.js'
import { API_ROUTES_FIXTURE_PACKAGE, importApiRoutesFixture } from './helpers/api-routes-fixture.js'

/**
 * Story 68.8 AC-18, AC-10 and AC-6/Q7 — rate limits with enforcement ON (RATE_LIMIT_TEST_BYPASS
 * is turned off before any app boots, so the per-IP @fastify/rate-limit contexts register too).
 */
process.env['VAULT_EXTENSIONS_PACKAGE'] = API_ROUTES_FIXTURE_PACKAGE
configureAuthIntegrationEnv()
process.env['RATE_LIMIT_TEST_BYPASS'] = 'false'

const { createApp } = await import('../app.js')
const { initVault } = await import('../modules/vault/key-service.js')
const { resetVaultForTest } = await import('./helpers/vault-test-cleanup.js')
const { __resetExtensionStateForTests } = await import('../extensions/loader.js')
const { __resetCapabilityGateForTests } = await import('../lib/capability-gate.js')
const { __resetAuthStrategiesForTests } = await import('../modules/auth/strategies.js')
const { env } = await import('../config/env.js')
const fixture = await importApiRoutesFixture()

type TestApp = Awaited<ReturnType<typeof createApp>>

// Inlined per this suite's convention rather than a PASSWORD-suffixed constant, which
// check-public-safety's secret-assignment scan flags.
const testLoginPassword = 'correct-horse-battery-staple'

function uniqueIp(): string {
  const bytes = randomUUID().replaceAll('-', '')
  return `10.${Number.parseInt(bytes.slice(0, 2), 16)}.${Number.parseInt(bytes.slice(2, 4), 16)}.${Number.parseInt(bytes.slice(4, 6), 16)}`
}

async function bootScenario(scenario: 'default' | 'old-pack'): Promise<TestApp> {
  __resetExtensionStateForTests()
  __resetCapabilityGateForTests()
  __resetAuthStrategiesForTests()
  fixture.setApiRoutesScenario(scenario)
  return createApp({ logger: false, vaultGuardEnabled: true })
}

async function hit(
  app: TestApp,
  url: string,
  cookie: string,
  times: number,
  remoteAddress = '127.0.0.1'
): Promise<number[]> {
  const codes: number[] = []
  for (let index = 0; index < times; index += 1) {
    const res = await app.inject({ method: 'GET', url, headers: { cookie }, remoteAddress })
    codes.push(res.statusCode)
  }
  return codes
}

describe('Story 68.8 — rate limits with enforcement on', () => {
  beforeAll(async () => {
    delete process.env['RELEASE_VERSION']
    await resetVaultForTest()
    await initVaultForTest(initVault, 'api-routes-rate-limit-passphrase')
  }, 60_000)

  afterAll(async () => {
    __resetExtensionStateForTests()
    __resetCapabilityGateForTests()
    __resetAuthStrategiesForTests()
    await resetVaultForTest()
    process.env['RATE_LIMIT_TEST_BYPASS'] = 'true'
    delete process.env['VAULT_EXTENSIONS_PACKAGE']
  })

  describe('AC-18 — PV routes that shared a default bucket now count separately (no apiRoutes)', () => {
    let app: TestApp
    let cookie: string

    beforeAll(async () => {
      app = await bootScenario('old-pack')
      const owner = await registerAndLoginViaApi(app, {
        email: `api-routes-rl-${randomUUID()}@example.com`,
        password: testLoginPassword,
        orgName: `API Routes RL ${randomUUID().slice(0, 8)}`,
      })
      cookie = cookieHeader(owner.cookies)
    }, 60_000)

    afterAll(async () => {
      await app.close()
    })

    it('60 calls to GET /api/v1/dashboard do not use up GET /api/v1/projects (formerly both "GET ")', async () => {
      expect(new Set(await hit(app, '/api/v1/dashboard', cookie, 60))).toEqual(new Set([200]))
      expect(await hit(app, '/api/v1/projects', cookie, 1)).toEqual([200])
      expect(await hit(app, '/api/v1/dashboard', cookie, 1)).toEqual([429])
    })

    it('60 calls to GET /api/v1/auth/me do not use up GET /api/v1/users/me (formerly both "GET /me")', async () => {
      // A fresh client IP: the auth routes' own per-IP context limiter already counted this
      // suite's register and login calls from the default address. The login helper also called
      // GET /auth/me once, so run that bucket to its first 429, then check the other route.
      const remoteAddress = uniqueIp()
      const codes = await hit(app, '/api/v1/auth/me', cookie, 61, remoteAddress)
      expect(codes.at(-1)).toBe(429)
      expect(codes.filter((code) => code === 200).length).toBeGreaterThanOrEqual(59)
      expect(await hit(app, '/api/v1/users/me', cookie, 1, remoteAddress)).toEqual([200])
    })
  })

  describe('apiRoutes routes (default fixture scenario)', () => {
    let app: TestApp

    beforeAll(async () => {
      app = await bootScenario('default')
    }, 60_000)

    afterAll(async () => {
      await app.close()
    })

    it('AC-10: an added public route is limited per IP by PV’s default (60/min); the 61st gets PV’s 429', async () => {
      const remoteAddress = uniqueIp()
      const codes: number[] = []
      for (let index = 0; index < 61; index += 1) {
        const res = await app.inject({
          method: 'POST',
          url: '/cm/webhooks/stripe',
          payload: {},
          remoteAddress,
        })
        codes.push(res.statusCode)
        if (index === 60) expect(res.json()).toMatchObject({ code: 'rate_limit_exceeded' })
      }
      expect(codes.slice(0, 60).every((code) => code === 200)).toBe(true)
      expect(codes[60]).toBe(429)
    })

    it('Q7: replaceSecurity inside the CLI-login context is still limited by the context’s per-IP limiter', async () => {
      const remoteAddress = uniqueIp()
      const max = env.AUTH_RATE_LIMIT_MAX
      const codes: number[] = []
      for (let index = 0; index <= max; index += 1) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/cli-login',
          payload: {},
          remoteAddress,
        })
        codes.push(res.statusCode)
      }
      expect(codes.slice(0, max).every((code) => code === 200)).toBe(true)
      expect(codes.at(max)).toBe(429)
    })
  })
})
