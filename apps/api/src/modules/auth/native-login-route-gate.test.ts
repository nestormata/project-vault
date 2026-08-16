import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { getDb } from '@project-vault/db'
import { users } from '@project-vault/db/schema'
import {
  bootUnsealedRouteApp,
  bootstrapRouteIntegrationTest,
} from '../../__tests__/helpers/auth-test-helpers.js'
import {
  __resetNativeLoginPolicyForTests,
  markReplacementProven,
  resolveNativeLoginPolicy,
} from './native-login-policy.js'
import type { ExtensionState } from '../../extensions/loader.js'

process.env['DATABASE_URL'] ??=
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'
// This suite reuses one shared app across many gate assertions on the same rate-limited routes
// (mfa/recover, recovery/request) — not testing rate limiting itself, so bypass it explicitly
// (see route-helpers.ts's isRateLimitEnforced() doc comment).
process.env['RATE_LIMIT_TEST_BYPASS'] = 'true'

const { initVault } = await bootstrapRouteIntegrationTest()

const DECLARED_LOADED: ExtensionState = {
  status: 'loaded',
  manifest: {
    name: 'test.mock-envelope-extension',
    apiVersion: '1.2.0',
    capabilities: ['auth-provider'],
    replacesNativeLogin: true,
  },
  loadedAt: new Date().toISOString(),
  hooks: {
    authStrategy: {
      onAuthenticate: async () => ({ externalSubject: 'x', providerName: 'test' }),
    },
  },
}

/** Forces the shared native-login-policy module to `disabled` for the current process — the
 * gated routes read the live module state per-request, so this affects the already-created
 * `app` too (no per-test createApp() needed). */
async function forcePolicyDisabled(): Promise<void> {
  await markReplacementProven()
  __resetNativeLoginPolicyForTests()
  await resolveNativeLoginPolicy(DECLARED_LOADED)
}

async function forcePolicyEnabled(): Promise<void> {
  __resetNativeLoginPolicyForTests()
  await resolveNativeLoginPolicy({ status: 'not_configured' })
}

const POST = 'POST'
const TEST_EMAIL = 'a@example.com'
const TEST_PASSWORD = 'CorrectHorseBattery9!'
const REGISTER_URL = '/api/v1/auth/register'

let app: Awaited<ReturnType<typeof bootUnsealedRouteApp>>['app']
let closeSuite: () => Promise<void>

beforeAll(async () => {
  const suite = await bootUnsealedRouteApp(initVault, 'a-correct-horse-battery-staple-passphrase')
  app = suite.app
  closeSuite = suite.close
})

afterAll(async () => {
  await closeSuite()
})

beforeEach(async () => {
  await forcePolicyEnabled()
  await getDb().delete(users)
  // /mfa/recover and /recovery/request share a DB-backed (not RATE_LIMIT_TEST_BYPASS-gated)
  // IP bucket — reset it each test so this suite's own volume of requests never trips it.
  await getDb().execute(sql`DELETE FROM auth_rate_limit_buckets`)
})

describe('Story 23.2 AC-6: native-credential surface fails closed', () => {
  const GATED_CASES: Array<{ name: string; method: string; url: string; body?: unknown }> = [
    {
      name: 'login',
      method: POST,
      url: '/api/v1/auth/login',
      body: { email: TEST_EMAIL, password: 'x' },
    },
    {
      name: 'mfa/verify-login',
      method: POST,
      url: '/api/v1/auth/mfa/verify-login',
      body: { pendingSessionToken: 'x', totpCode: '123456' },
    },
    {
      name: 'mfa/recover',
      method: POST,
      url: '/api/v1/auth/mfa/recover',
      body: { email: TEST_EMAIL, password: 'x', recoveryCode: 'x' },
    },
    {
      name: 'recovery/request',
      method: POST,
      url: '/api/v1/auth/recovery/request',
      body: { email: TEST_EMAIL },
    },
    { name: 'recovery/:token (GET peek)', method: 'GET', url: '/api/v1/auth/recovery/some-token' },
    {
      name: 'recovery/:token/mfa/start',
      method: POST,
      url: '/api/v1/auth/recovery/some-token/mfa/start',
    },
    {
      name: 'recovery/:token/complete',
      method: POST,
      url: '/api/v1/auth/recovery/some-token/complete',
      body: { password: TEST_PASSWORD },
    },
  ]

  for (const testCase of GATED_CASES) {
    it(`${testCase.name}: 403 native_login_disabled when policy is disabled, before any credential work`, async () => {
      await forcePolicyDisabled()
      const res = await app.inject({
        method: testCase.method as 'GET' | 'POST',
        url: testCase.url,
        payload: testCase.body,
      })
      expect(res.statusCode).toBe(403)
      expect(res.json()).toMatchObject({ code: 'native_login_disabled' })
    })

    it(`${testCase.name}: unaffected (not 403) when policy is enabled`, async () => {
      await forcePolicyEnabled()
      const res = await app.inject({
        method: testCase.method as 'GET' | 'POST',
        url: testCase.url,
        payload: testCase.body,
      })
      expect(res.statusCode).not.toBe(403)
    })
  }

  it('AC-5: request-supplied fields cannot influence the gate in either direction', async () => {
    await forcePolicyDisabled()
    const res = await app.inject({
      method: POST,
      url: '/api/v1/auth/login',
      headers: { 'x-native-login': 'enabled', 'x-vault-break-glass': 'true' },
      payload: { email: TEST_EMAIL, password: 'x', nativeLoginEnabled: true },
    })
    expect(res.statusCode).toBe(403)
  })

  it('AC-6a bootstrap carve-out: first POST /register succeeds even when policy is disabled, on an empty users table', async () => {
    await forcePolicyDisabled()
    const res = await app.inject({
      method: POST,
      url: REGISTER_URL,
      payload: {
        email: `bootstrap-${randomUUID()}@example.com`,
        password: TEST_PASSWORD,
        orgName: `bootstrap org ${randomUUID()}`,
      },
    })
    expect(res.statusCode).toBe(201)
  })

  it('AC-6a: a SECOND registration after the first is gated (native_login_disabled)', async () => {
    await forcePolicyDisabled()
    const first = await app.inject({
      method: POST,
      url: REGISTER_URL,
      payload: {
        email: `bootstrap-first-${randomUUID()}@example.com`,
        password: TEST_PASSWORD,
        orgName: `bootstrap org ${randomUUID()}`,
      },
    })
    expect(first.statusCode).toBe(201)

    const second = await app.inject({
      method: POST,
      url: REGISTER_URL,
      payload: {
        email: `bootstrap-second-${randomUUID()}@example.com`,
        password: TEST_PASSWORD,
        orgName: 'another org',
      },
    })
    expect(second.statusCode).toBe(403)
    expect(second.json()).toMatchObject({ code: 'native_login_disabled' })
  })
})
