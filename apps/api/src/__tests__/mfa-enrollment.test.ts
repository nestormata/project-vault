import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import * as OTPAuth from 'otpauth'
import { getDb } from '@project-vault/db'
import { mfaEnrollments } from '@project-vault/db/schema'

process.env['DATABASE_URL'] ??=
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'
process.env['VAULT_ALLOW_REMOTE_INIT'] = 'true'

const { createApp } = await import('../app.js')
const { initVault } = await import('../modules/vault/key-service.js')
const { resetVaultForTest } = await import('./helpers/vault-test-cleanup.js')

const PASSWORD = 'correct-horse-battery-staple'
const TEST_PASSPHRASE = 'mfa-tests-passphrase'
const AUTH_ME_URL = '/api/v1/auth/me'
const MFA_RECOVER_URL = '/api/v1/auth/mfa/recover'

type CookieJar = Record<string, string>

function parseSetCookies(setCookie: string | string[] | undefined): CookieJar {
  const headers = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []
  return Object.fromEntries(
    headers
      .map((header) => header.split(';')[0] ?? '')
      .filter(Boolean)
      .map((cookie) => {
        const [name, ...valueParts] = cookie.split('=')
        return [name, valueParts.join('=')]
      })
  )
}

function cookieHeader(jar: CookieJar): string {
  return Object.entries(jar)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ')
}

function totpForSecret(base32: string): string {
  return new OTPAuth.TOTP({
    secret: OTPAuth.Secret.fromBase32(base32),
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
  }).generate()
}

async function registerAndLogin() {
  const app = await createApp({ logger: false })
  const email = `mfa-${randomUUID()}@example.com`
  const register = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email, password: PASSWORD, orgName: `MFA Test ${randomUUID()}` },
  })
  expect(register.statusCode).toBe(201)
  const registerBody = register.json<{ data: { userId: string } }>()

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password: PASSWORD },
  })
  expect(login.statusCode).toBe(200)
  await app.close()
  return {
    userId: registerBody.data.userId,
    email,
    cookies: parseSetCookies(login.headers['set-cookie']),
  }
}

async function enrollAndVerify(app: Awaited<ReturnType<typeof createApp>>, cookies: string) {
  const enroll = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/mfa/enroll',
    headers: { cookie: cookies },
    payload: {},
  })
  expect(enroll.statusCode).toBe(200)
  const enrollBody = enroll.json<{ data: { secret: string; qrCodeSvg: string } }>()
  expect(enrollBody.data.qrCodeSvg).toContain('<svg')

  const verify = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/mfa/verify-enrollment',
    headers: { cookie: cookies },
    payload: { totp: totpForSecret(enrollBody.data.secret) },
  })
  expect(verify.statusCode).toBe(200)
  return verify.json<{ data: { recoveryCodes: string[] } }>().data.recoveryCodes
}

describe.sequential('MFA enrollment integration', () => {
  beforeAll(async () => {
    await resetVaultForTest()
    try {
      await initVault({ kmsType: 'passphrase', passphrase: TEST_PASSPHRASE }, {})
    } catch (error) {
      if ((error as { code?: string }).code !== 'ALREADY_INITIALIZED') throw error
    }
  })

  afterAll(async () => {
    await resetVaultForTest()
  })

  it('enrolls TOTP MFA and recovers with a single-use recovery code', async () => {
    const user = await registerAndLogin()
    const app = await createApp({ logger: false })
    const cookies = cookieHeader(user.cookies)

    const recoveryCodes = await enrollAndVerify(app, cookies)
    expect(recoveryCodes).toHaveLength(10)

    const meAfterEnroll = await app.inject({
      method: 'GET',
      url: AUTH_ME_URL,
      headers: { cookie: cookies },
    })
    expect(meAfterEnroll.statusCode).toBe(200)
    expect(meAfterEnroll.json()).toMatchObject({
      data: {
        mfaEnrolled: true,
        mfaEnrolledAt: expect.any(String),
        remainingRecoveryCodesCount: 10,
      },
    })

    const recover = await app.inject({
      method: 'POST',
      url: MFA_RECOVER_URL,
      payload: {
        email: user.email,
        password: PASSWORD,
        recoveryCode: recoveryCodes[0],
      },
    })
    expect(recover.statusCode).toBe(200)
    expect(recover.json()).toMatchObject({ data: { remainingRecoveryCodes: 9 } })
    const recoveryCookies = parseSetCookies(recover.headers['set-cookie'])
    expect(recoveryCookies['access-token']).toBeTruthy()

    const meAfterRecover = await app.inject({
      method: 'GET',
      url: AUTH_ME_URL,
      headers: { cookie: cookieHeader(recoveryCookies) },
    })
    expect(meAfterRecover.statusCode).toBe(200)
    expect(meAfterRecover.json()).toMatchObject({
      data: { mfaEnrolled: true, remainingRecoveryCodesCount: 9 },
    })

    const reuse = await app.inject({
      method: 'POST',
      url: MFA_RECOVER_URL,
      payload: {
        email: user.email,
        password: PASSWORD,
        recoveryCode: recoveryCodes[0],
      },
    })
    expect(reuse.statusCode).toBe(401)

    const concurrent = await Promise.all([
      app.inject({
        method: 'POST',
        url: MFA_RECOVER_URL,
        payload: { email: user.email, password: PASSWORD, recoveryCode: recoveryCodes[1] },
      }),
      app.inject({
        method: 'POST',
        url: MFA_RECOVER_URL,
        payload: { email: user.email, password: PASSWORD, recoveryCode: recoveryCodes[1] },
      }),
    ])
    expect(concurrent.map((res) => res.statusCode).sort()).toEqual([200, 401])
    await app.close()
  }, 20_000)

  it('returns Retry-After and retryAfterSeconds when recover email limit is exceeded', async () => {
    const user = await registerAndLogin()
    const app = await createApp({ logger: false })
    await enrollAndVerify(app, cookieHeader(user.cookies))

    let lastResponse
    for (let i = 0; i < 6; i += 1) {
      lastResponse = await app.inject({
        method: 'POST',
        url: MFA_RECOVER_URL,
        payload: { email: user.email, password: PASSWORD, recoveryCode: 'AAAAA-AAAAA' },
      })
    }

    expect(lastResponse?.statusCode).toBe(429)
    expect(lastResponse?.headers['retry-after']).toBeDefined()
    expect(lastResponse?.json()).toMatchObject({
      code: 'rate_limit_exceeded',
      retryAfterSeconds: expect.any(Number),
    })
    await app.close()
  }, 20_000)

  it('deletes pending MFA enrollment when the session is revoked', async () => {
    const user = await registerAndLogin()
    const app = await createApp({ logger: false })
    const cookies = cookieHeader(user.cookies)
    const enroll = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/enroll',
      headers: { cookie: cookies },
      payload: {},
    })
    expect(enroll.statusCode).toBe(200)

    const logout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: cookies },
    })
    expect(logout.statusCode).toBe(204)

    const rows = await getDb()
      .select({ id: mfaEnrollments.id })
      .from(mfaEnrollments)
      .where(and(eq(mfaEnrollments.status, 'pending'), eq(mfaEnrollments.userId, user.userId)))
    expect(rows).toHaveLength(0)
    await app.close()
  }, 20_000)
})
