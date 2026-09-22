import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { withOrg } from '@project-vault/db'
import { eq } from 'drizzle-orm'
import { orgMemberships } from '@project-vault/db/schema'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  initVaultForTest,
  registerAndLoginViaApi,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { totpForSecret } from '../../__tests__/helpers/totp.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'

vi.setConfig({ testTimeout: 30_000 })

const { createApp, initVault } = await bootstrapRouteIntegrationTest()
type TestApp = Awaited<ReturnType<typeof createApp>>

const PASSWORD = 'correct-horse-battery-staple'
const TEST_PASSPHRASE = 'cli-login-routes-passphrase'
const CLI_LOGIN_URL = '/api/v1/auth/cli-login'
const CLI_VERIFY_URL = '/api/v1/auth/cli/mfa/verify-login'
const CLI_REFRESH_URL = '/api/v1/auth/cli/refresh'
const CLI_LOGOUT_URL = '/api/v1/auth/cli/logout'

function uniqueEmail(label: string): string {
  return `cli-login-${label}-${randomUUID()}@example.com`
}

async function expireGracePeriod(userId: string, orgId: string) {
  await withOrg(orgId, (tx) =>
    tx
      .update(orgMemberships)
      .set({ gracePeriodExpiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000) })
      .where(eq(orgMemberships.userId, userId))
  )
}

describe('CLI JSON-bearer-token login routes (Story 43.2)', () => {
  let app: TestApp

  beforeAll(async () => {
    await resetVaultForTest()
    await initVaultForTest(initVault, TEST_PASSPHRASE)
    app = await createApp({ logger: false })
  })

  afterAll(async () => {
    await app?.close()
    await resetVaultForTest()
  })

  it('AC-2/AC-7: returns JSON bearer tokens (not Set-Cookie) for a no-MFA account', async () => {
    const email = uniqueEmail('no-mfa')
    await registerAndLoginViaApi(app, { email, password: PASSWORD, orgName: `Org ${randomUUID()}` })

    const res = await app.inject({
      method: 'POST',
      url: CLI_LOGIN_URL,
      payload: { email, password: PASSWORD },
    })

    expect(res.statusCode).toBe(200)
    expect(res.headers['set-cookie']).toBeFalsy()
    const body = res.json<{
      data: {
        accessToken: string
        refreshToken: string
        tokenType: string
        expiresIn: number
        userId: string
        orgId: string
      }
    }>()
    expect(body.data.tokenType).toBe('Bearer')
    expect(typeof body.data.accessToken).toBe('string')
    expect(typeof body.data.refreshToken).toBe('string')
    expect(body.data.expiresIn).toBeGreaterThan(0)
  })

  it('AC-2: returns the mfaRequired challenge shape for an MFA-enrolled account, then bearer tokens after verify', async () => {
    const email = uniqueEmail('mfa')
    const registered = await registerAndLoginViaApi(app, {
      email,
      password: PASSWORD,
      orgName: `Org ${randomUUID()}`,
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

    const challenge = await app.inject({
      method: 'POST',
      url: CLI_LOGIN_URL,
      payload: { email, password: PASSWORD },
    })
    expect(challenge.statusCode).toBe(200)
    expect(challenge.headers['set-cookie']).toBeFalsy()
    const challengeBody = challenge.json<{ data: { mfaRequired: boolean; mfaToken: string } }>()
    expect(challengeBody.data.mfaRequired).toBe(true)

    const verify = await app.inject({
      method: 'POST',
      url: CLI_VERIFY_URL,
      payload: {
        mfaToken: challengeBody.data.mfaToken,
        totp: totpForSecret(secret, Date.now() + 30_000),
      },
    })
    expect(verify.statusCode).toBe(200)
    expect(verify.headers['set-cookie']).toBeFalsy()
    const verifyBody = verify.json<{ data: { accessToken: string; refreshToken: string } }>()
    expect(typeof verifyBody.data.accessToken).toBe('string')
    expect(typeof verifyBody.data.refreshToken).toBe('string')
  })

  it('rejects invalid credentials with 401 and never a cookie', async () => {
    const email = uniqueEmail('bad-creds')
    await registerAndLoginViaApi(app, { email, password: PASSWORD, orgName: `Org ${randomUUID()}` })

    const res = await app.inject({
      method: 'POST',
      url: CLI_LOGIN_URL,
      payload: { email, password: 'totally-wrong-password' },
    })

    expect(res.statusCode).toBe(401)
    expect(res.headers['set-cookie']).toBeFalsy()
  })

  it('AC-4: /cli/refresh rotates and returns a fresh bearer pair for a valid refresh token', async () => {
    const email = uniqueEmail('refresh')
    await registerAndLoginViaApi(app, { email, password: PASSWORD, orgName: `Org ${randomUUID()}` })
    const login = await app.inject({
      method: 'POST',
      url: CLI_LOGIN_URL,
      payload: { email, password: PASSWORD },
    })
    const { refreshToken } = login.json<{ data: { refreshToken: string } }>().data

    const refreshed = await app.inject({
      method: 'POST',
      url: CLI_REFRESH_URL,
      payload: { refreshToken },
    })

    expect(refreshed.statusCode).toBe(200)
    const body = refreshed.json<{
      data: { accessToken: string; refreshToken: string; expiresIn: number }
    }>()
    expect(typeof body.data.accessToken).toBe('string')
    expect(body.data.refreshToken).not.toBe(refreshToken)
  })

  it('/cli/refresh rejects an invalid/unknown refresh token with 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: CLI_REFRESH_URL,
      payload: { refreshToken: 'not-a-real-refresh-token' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('AC-6: /cli/logout revokes the session for a valid refresh token', async () => {
    const email = uniqueEmail('logout')
    await registerAndLoginViaApi(app, { email, password: PASSWORD, orgName: `Org ${randomUUID()}` })
    const login = await app.inject({
      method: 'POST',
      url: CLI_LOGIN_URL,
      payload: { email, password: PASSWORD },
    })
    const { refreshToken } = login.json<{ data: { refreshToken: string } }>().data

    const logout = await app.inject({
      method: 'POST',
      url: CLI_LOGOUT_URL,
      payload: { refreshToken },
    })

    expect(logout.statusCode).toBe(200)
    expect(logout.json<{ data: { revoked: boolean } }>().data.revoked).toBe(true)

    // The now-revoked refresh token can no longer refresh a session.
    const refreshAfterLogout = await app.inject({
      method: 'POST',
      url: CLI_REFRESH_URL,
      payload: { refreshToken },
    })
    expect(refreshAfterLogout.statusCode).toBe(401)
  })

  it('/cli/logout with no refreshToken body is a success no-op (AC-6 idempotent semantics)', async () => {
    const res = await app.inject({ method: 'POST', url: CLI_LOGOUT_URL, payload: {} })
    expect(res.statusCode).toBe(200)
    expect(res.json<{ data: { revoked: boolean } }>().data.revoked).toBe(false)
  })

  it('/cli/logout with an unknown refresh token is still a success, not an error', async () => {
    const res = await app.inject({
      method: 'POST',
      url: CLI_LOGOUT_URL,
      payload: { refreshToken: 'unknown-token-value' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json<{ data: { revoked: boolean } }>().data.revoked).toBe(false)
  })

  // Native-login-disabled gating is not covered separately here: `/cli-login` calls the exact
  // same exported `rejectIfNativeLoginDisabled()` gate (see cli-login-routes.ts) that the
  // cookie-based `/login` route in routes.ts uses, and that shared function already has its own
  // dedicated coverage (routes.test.ts). This file only asserts the CLI's response *shape*
  // differs (JSON body, no cookie) for the outcomes that DO exercise this route directly.
})

describe('CLI login routes — POST-only', () => {
  it('rejects GET with 405', async () => {
    const app = await createApp({ logger: false })
    const res = await app.inject({ method: 'GET', url: CLI_LOGIN_URL })
    expect(res.statusCode).toBe(405)
    await app.close()
  })
})
