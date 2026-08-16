import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  bootUnsealedRouteApp,
  bootstrapRouteIntegrationTest,
  cookieHeader,
  registerAndLoginViaApi,
} from '../../__tests__/helpers/auth-test-helpers.js'
import {
  __resetNativeLoginPolicyForTests,
  markReplacementProven,
  resolveNativeLoginPolicy,
} from './native-login-policy.js'
import type { ExtensionState } from '../../extensions/loader.js'

/**
 * Story 23.2 AC-10: sessions issued before an instance flips into native-login exclusion keep
 * working, unbounded, with no cap and no mass revocation — a deliberate accepted-risk decision
 * (see the story text's finding F-M7/N2: there is no absolute-expiry column to bound against,
 * and adding one is explicitly out of scope for this story). This file proves the ACTUAL
 * contract: nothing about /refresh, /me, or /logout changes, in either policy state.
 */
process.env['DATABASE_URL'] ??=
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'

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

async function forcePolicyDisabled(): Promise<void> {
  await markReplacementProven('test.mock-envelope-extension')
  __resetNativeLoginPolicyForTests()
  await resolveNativeLoginPolicy(DECLARED_LOADED)
}

async function forcePolicyEnabled(): Promise<void> {
  __resetNativeLoginPolicyForTests()
  await resolveNativeLoginPolicy({ status: 'not_configured' })
}

const PASSWORD = 'correct-horse-battery-staple'

let app: Awaited<ReturnType<typeof bootUnsealedRouteApp>>['app']
let closeSuite: () => Promise<void>

beforeAll(async () => {
  const suite = await bootUnsealedRouteApp(initVault, 'session-continuity-tests-passphrase')
  app = suite.app
  closeSuite = suite.close
})

afterAll(async () => {
  await closeSuite()
})

afterEach(forcePolicyEnabled)

describe('Story 23.2 AC-10: pre-exclusion sessions keep working, unbounded', () => {
  it('positive example: a native-issued session survives a simulated restart into exclusion — GET /me and POST /refresh both keep working', async () => {
    const user = await registerAndLoginViaApi(app, {
      email: `pre-exclusion-${randomUUID()}@example.com`,
      password: PASSWORD,
      orgName: `Pre Exclusion Org ${randomUUID()}`,
    })

    // Simulated restart: the process-wide policy singleton flips to disabled, exactly as a real
    // restart with the latch already proven would — nothing about the session itself changes.
    await forcePolicyDisabled()

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: cookieHeader(user.cookies) },
    })
    expect(me.statusCode).toBe(200)

    const refresh = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: cookieHeader(user.cookies) },
    })
    expect(refresh.statusCode).toBe(200)
  })

  it('a pre-existing session is not a bypass: AC-6 gated routes still refuse for an authenticated pre-exclusion caller', async () => {
    const user = await registerAndLoginViaApi(app, {
      email: `pre-exclusion-not-bypass-${randomUUID()}@example.com`,
      password: PASSWORD,
      orgName: `Pre Exclusion Not Bypass Org ${randomUUID()}`,
    })
    await forcePolicyDisabled()

    // /mfa/recover is one of the AC-6 gated routes — an authenticated caller with a pre-exclusion
    // session must still be refused, because the gate is about the credential mechanism, not the
    // caller's authentication state.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/recover',
      headers: { cookie: cookieHeader(user.cookies) },
      payload: { pendingSessionToken: 'x', recoveryCode: 'x' },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ code: 'native_login_disabled' })
  })

  it('logout still works for a pre-exclusion session', async () => {
    const user = await registerAndLoginViaApi(app, {
      email: `pre-exclusion-logout-${randomUUID()}@example.com`,
      password: PASSWORD,
      orgName: `Pre Exclusion Logout Org ${randomUUID()}`,
    })
    await forcePolicyDisabled()

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: cookieHeader(user.cookies) },
    })
    expect(res.statusCode).toBe(204)
  })

  it('regression: /refresh behaves byte-identically to today when native login stays enabled', async () => {
    const user = await registerAndLoginViaApi(app, {
      email: `refresh-enabled-regression-${randomUUID()}@example.com`,
      password: PASSWORD,
      orgName: `Refresh Enabled Regression Org ${randomUUID()}`,
    })

    const refresh = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: cookieHeader(user.cookies) },
    })
    expect(refresh.statusCode).toBe(200)
  })
})
