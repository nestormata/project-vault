import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { getDb, withOrg } from '@project-vault/db'
import { orgMemberships } from '@project-vault/db/schema'
import {
  configureAuthIntegrationEnv,
  cookieHeader,
  initVaultForTest,
  parseSetCookies,
  registerAndLoginViaApi,
} from './helpers/auth-test-helpers.js'
import { registerPrivilegedTestRoute } from './helpers/privileged-test-route.js'
import { totpForSecret } from './helpers/totp.js'

configureAuthIntegrationEnv()
vi.setConfig({ testTimeout: 30_000 })

const { createApp } = await import('../app.js')
const { initVault } = await import('../modules/vault/key-service.js')
const { resetVaultForTest } = await import('./helpers/vault-test-cleanup.js')

const PASSWORD = 'correct-horse-battery-staple'
const TEST_PASSPHRASE = 'mfa-journey-passphrase'
const PRIVILEGED_URL = '/api/v1/test/privileged-action'
const AUTH_LOGIN_URL = '/api/v1/auth/login'
const MFA_VERIFY_LOGIN_URL = '/api/v1/auth/mfa/verify-login'

async function expireGracePeriod(userId: string, orgId: string) {
  await withOrg(orgId, (tx) =>
    tx
      .update(orgMemberships)
      .set({ gracePeriodExpiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000) })
      .where(eq(orgMemberships.userId, userId))
  )
}

describe.sequential('MFA journey (Epic 1 retro P3)', () => {
  beforeAll(async () => {
    await resetVaultForTest()
    await initVaultForTest(initVault, TEST_PASSPHRASE)
  })

  afterAll(async () => {
    await resetVaultForTest()
  })

  beforeEach(async () => {
    await getDb().execute(sql`DELETE FROM pending_mfa_sessions`)
  })

  it('enrolls MFA, completes login challenge, and accesses a privileged route', async () => {
    const app = await createApp({ logger: false })
    registerPrivilegedTestRoute(app)
    const email = `mfa-journey-${randomUUID()}@example.com`

    const registered = await registerAndLoginViaApi(app, {
      email,
      password: PASSWORD,
      orgName: `MFA Journey ${randomUUID()}`,
    })

    const enroll = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/enroll',
      headers: { cookie: cookieHeader(registered.cookies) },
      payload: {},
    })
    expect(enroll.statusCode).toBe(200)
    const secret = enroll.json<{ data: { secret: string } }>().data.secret

    const verifyEnrollment = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/verify-enrollment',
      headers: { cookie: cookieHeader(registered.cookies) },
      payload: { totp: totpForSecret(secret) },
    })
    expect(verifyEnrollment.statusCode).toBe(200)

    await expireGracePeriod(registered.userId, registered.orgId)

    const loginChallenge = await app.inject({
      method: 'POST',
      url: AUTH_LOGIN_URL,
      payload: { email, password: PASSWORD },
    })
    expect(loginChallenge.statusCode).toBe(200)
    const challengeBody = loginChallenge.json<{
      data: { mfaRequired: boolean; mfaToken: string }
    }>()
    expect(challengeBody.data).toMatchObject({ mfaRequired: true, mfaToken: expect.any(String) })
    expect(parseSetCookies(loginChallenge.headers['set-cookie'])['access-token']).toBeFalsy()

    const verifyLogin = await app.inject({
      method: 'POST',
      url: MFA_VERIFY_LOGIN_URL,
      payload: {
        mfaToken: challengeBody.data.mfaToken,
        totp: totpForSecret(secret, Date.now() + 30_000),
      },
    })
    expect(verifyLogin.statusCode).toBe(200)
    const sessionCookies = parseSetCookies(verifyLogin.headers['set-cookie'])
    expect(sessionCookies['access-token']).toBeTruthy()

    const privileged = await app.inject({
      method: 'POST',
      url: PRIVILEGED_URL,
      headers: { cookie: cookieHeader(sessionCookies) },
    })
    expect(privileged.statusCode).toBe(200)
    expect(privileged.json()).toMatchObject({ ok: true, action: 'privileged_mock' })

    await app.close()
  })
})
