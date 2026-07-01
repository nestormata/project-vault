import { randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { getDb } from '@project-vault/db'
import { mfaEnrollments, totpUsedCodes } from '@project-vault/db/schema'
import {
  configureAuthIntegrationEnv,
  cookieHeader,
  parseSetCookies,
} from './helpers/auth-test-helpers.js'
import {
  enrollAndVerifyMfa,
  enrollAndVerifyMfaWithSecret,
  registerAndLoginForMfaTests,
  registerMfaIntegrationLifecycle,
  startMfaEnrollment,
} from './helpers/mfa-enrollment-test-helpers.js'
import { totpForSecret } from './helpers/totp.js'

configureAuthIntegrationEnv()

const { createApp } = await import('../app.js')
const { initVault } = await import('../modules/vault/key-service.js')
const { verifyConfirmedLoginTotp } = await import('../modules/auth/mfa.js')
const { pruneMfaPendingEnrollments } = await import('../workers/prune-mfa-pending.js')
const { resetVaultForTest } = await import('./helpers/vault-test-cleanup.js')

const PASSWORD = 'correct-horse-battery-staple'
const TEST_PASSPHRASE = 'mfa-tests-passphrase'
const AUTH_ME_URL = '/api/v1/auth/me'
const MFA_ENROLL_URL = '/api/v1/auth/mfa/enroll'
const MFA_VERIFY_ENROLLMENT_URL = '/api/v1/auth/mfa/verify-enrollment'
const MFA_REGENERATE_RECOVERY_CODES_URL = '/api/v1/auth/mfa/regenerate-recovery-codes'
const MFA_RECOVER_URL = '/api/v1/auth/mfa/recover'

async function registerAndLogin() {
  const { userId, email, cookies } = await registerAndLoginForMfaTests(createApp, PASSWORD, 'mfa')
  return { userId, email, cookies }
}

async function enrollAndVerify(app: Awaited<ReturnType<typeof createApp>>, cookies: string) {
  return enrollAndVerifyMfa(app, cookies)
}

async function startEnrollment(app: Awaited<ReturnType<typeof createApp>>, cookies: string) {
  return startMfaEnrollment(app, cookies)
}

async function pendingEnrollmentRows(userId: string) {
  return getDb()
    .select({ id: mfaEnrollments.id })
    .from(mfaEnrollments)
    .where(and(eq(mfaEnrollments.status, 'pending'), eq(mfaEnrollments.userId, userId)))
}

async function expectNoPendingEnrollment(userId: string): Promise<void> {
  await expect(pendingEnrollmentRows(userId)).resolves.toHaveLength(0)
}

async function enrollAndVerifyWithSecret(
  app: Awaited<ReturnType<typeof createApp>>,
  cookies: string
) {
  return enrollAndVerifyMfaWithSecret(app, cookies)
}

describe.sequential('MFA enrollment integration', () => {
  registerMfaIntegrationLifecycle({ initVault, passphrase: TEST_PASSPHRASE, resetVaultForTest })

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
  }, 40_000)

  it('deletes pending enrollment on invalid TOTP and stores no plaintext base32 secret', async () => {
    const user = await registerAndLogin()
    const app = await createApp({ logger: false })
    const cookies = cookieHeader(user.cookies)

    const secret = await startEnrollment(app, cookies)

    const storedRows = await getDb()
      .select({ secretEncrypted: mfaEnrollments.secretEncrypted })
      .from(mfaEnrollments)
      .where(and(eq(mfaEnrollments.status, 'pending'), eq(mfaEnrollments.userId, user.userId)))
    expect(storedRows).toHaveLength(1)
    expect(JSON.stringify(storedRows[0]?.secretEncrypted)).not.toContain(secret)

    const verify = await app.inject({
      method: 'POST',
      url: MFA_VERIFY_ENROLLMENT_URL,
      headers: { cookie: cookies },
      payload: { totp: '000000' },
    })
    expect(verify.statusCode).toBe(422)

    await expectNoPendingEnrollment(user.userId)

    await app.close()
  }, 45_000)

  it('accepts a TOTP from the previous clock-skew window', async () => {
    const user = await registerAndLogin()
    const app = await createApp({ logger: false })
    const cookies = cookieHeader(user.cookies)
    const secret = await startEnrollment(app, cookies)

    const verify = await app.inject({
      method: 'POST',
      url: MFA_VERIFY_ENROLLMENT_URL,
      headers: { cookie: cookies },
      payload: { totp: totpForSecret(secret, Date.now() - 30_000) },
    })

    expect(verify.statusCode).toBe(200)
    await app.close()
  }, 45_000)

  it('rejects replaying an already used TOTP counter', async () => {
    const user = await registerAndLogin()
    const app = await createApp({ logger: false })
    const cookies = cookieHeader(user.cookies)
    const secret = await startEnrollment(app, cookies)
    const token = totpForSecret(secret)

    const verify = await app.inject({
      method: 'POST',
      url: MFA_VERIFY_ENROLLMENT_URL,
      headers: { cookie: cookies },
      payload: { totp: token },
    })
    expect(verify.statusCode).toBe(200)

    const replay = await app.inject({
      method: 'POST',
      url: MFA_REGENERATE_RECOVERY_CODES_URL,
      headers: { cookie: cookies },
      payload: { totp: `${token.slice(0, 3)} ${token.slice(3)}` },
    })

    expect(replay.statusCode).toBe(422)
    expect(replay.json()).toMatchObject({ code: 'invalid_totp' })
    await app.close()
  }, 45_000)

  it('reuses confirmed-enrollment TOTP verification for login checks', async () => {
    const user = await registerAndLogin()
    const app = await createApp({ logger: false })
    const cookies = cookieHeader(user.cookies)
    const { secret } = await enrollAndVerifyWithSecret(app, cookies)

    const loginToken = totpForSecret(secret, Date.now() + 30_000)
    await getDb().transaction(async (tx) => {
      await expect(verifyConfirmedLoginTotp(tx, user.userId, loginToken)).resolves.toBe('valid')
      await expect(verifyConfirmedLoginTotp(tx, user.userId, loginToken)).resolves.toBe(
        'replayed_code'
      )
      await expect(verifyConfirmedLoginTotp(tx, user.userId, '000000')).resolves.toBe(
        'invalid_code'
      )
      await expect(verifyConfirmedLoginTotp(tx, randomUUID(), loginToken)).resolves.toBe(
        'no_enrollment'
      )
    })

    await app.close()
  }, 45_000)

  it('allows exactly one concurrent enrollment verification for one TOTP', async () => {
    const user = await registerAndLogin()
    const app = await createApp({ logger: false })
    const cookies = cookieHeader(user.cookies)
    const secret = await startEnrollment(app, cookies)
    const totp = totpForSecret(secret)

    const responses = await Promise.all([
      app.inject({
        method: 'POST',
        url: MFA_VERIFY_ENROLLMENT_URL,
        headers: { cookie: cookies },
        payload: { totp },
      }),
      app.inject({
        method: 'POST',
        url: MFA_VERIFY_ENROLLMENT_URL,
        headers: { cookie: cookies },
        payload: { totp },
      }),
    ])

    expect(responses.map((res) => res.statusCode).sort()).toEqual([200, 422])
    await app.close()
  }, 45_000)

  it('rejects a second enrollment after MFA is confirmed', async () => {
    const user = await registerAndLogin()
    const app = await createApp({ logger: false })
    const cookies = cookieHeader(user.cookies)

    await enrollAndVerify(app, cookies)
    const secondEnroll = await app.inject({
      method: 'POST',
      url: MFA_ENROLL_URL,
      headers: { cookie: cookies },
      payload: {},
    })

    expect(secondEnroll.statusCode).toBe(409)
    expect(secondEnroll.json()).toMatchObject({ code: 'mfa_already_enrolled' })
    await app.close()
  }, 45_000)

  it('rejects recovery login for a user without MFA enrolled', async () => {
    const user = await registerAndLogin()
    const app = await createApp({ logger: false })

    const recover = await app.inject({
      method: 'POST',
      url: MFA_RECOVER_URL,
      payload: { email: user.email, password: PASSWORD, recoveryCode: 'K7F2M-9QPNX' },
    })

    expect(recover.statusCode).toBe(401)
    expect(recover.json()).toMatchObject({ code: 'invalid_credentials' })
    await app.close()
  }, 45_000)

  it('does not invalidate existing recovery codes when regenerate TOTP is invalid', async () => {
    const user = await registerAndLogin()
    const app = await createApp({ logger: false })
    const cookies = cookieHeader(user.cookies)
    const recoveryCodes = await enrollAndVerify(app, cookies)

    const regenerate = await app.inject({
      method: 'POST',
      url: MFA_REGENERATE_RECOVERY_CODES_URL,
      headers: { cookie: cookies },
      payload: { totp: '000000' },
    })
    expect(regenerate.statusCode).toBe(422)

    const recover = await app.inject({
      method: 'POST',
      url: MFA_RECOVER_URL,
      payload: { email: user.email, password: PASSWORD, recoveryCode: recoveryCodes[0] },
    })
    expect(recover.statusCode).toBe(200)
    await app.close()
  }, 45_000)

  it('regenerates recovery codes and invalidates old unused codes', async () => {
    const user = await registerAndLogin()
    const app = await createApp({ logger: false })
    const cookies = cookieHeader(user.cookies)
    const { secret, recoveryCodes: firstCodes } = await enrollAndVerifyWithSecret(app, cookies)
    await getDb().delete(totpUsedCodes).where(eq(totpUsedCodes.userId, user.userId))

    const regenerate = await app.inject({
      method: 'POST',
      url: MFA_REGENERATE_RECOVERY_CODES_URL,
      headers: { cookie: cookies },
      payload: { totp: totpForSecret(secret) },
    })
    expect(regenerate.statusCode).toBe(200)
    const newCodes = regenerate.json<{ data: { recoveryCodes: string[] } }>().data.recoveryCodes
    expect(newCodes).toHaveLength(10)

    const oldCodeRecover = await app.inject({
      method: 'POST',
      url: MFA_RECOVER_URL,
      payload: { email: user.email, password: PASSWORD, recoveryCode: firstCodes[0] },
    })
    expect(oldCodeRecover.statusCode).toBe(401)

    const newCodeRecover = await app.inject({
      method: 'POST',
      url: MFA_RECOVER_URL,
      payload: { email: user.email, password: PASSWORD, recoveryCode: newCodes[0] },
    })
    expect(newCodeRecover.statusCode).toBe(200)
    await app.close()
  }, 45_000)

  it('prunes pending enrollments older than 24 hours', async () => {
    const user = await registerAndLogin()
    const app = await createApp({ logger: false })
    const cookies = cookieHeader(user.cookies)

    await startEnrollment(app, cookies)

    await getDb()
      .update(mfaEnrollments)
      .set({ createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
      .where(and(eq(mfaEnrollments.status, 'pending'), eq(mfaEnrollments.userId, user.userId)))
    await pruneMfaPendingEnrollments({ info: () => undefined, error: () => undefined })

    await expectNoPendingEnrollment(user.userId)
    await app.close()
  }, 45_000)

  it('returns Retry-After and retryAfterSeconds when recover email limit is exceeded', async () => {
    const user = await registerAndLogin()
    const app = await createApp({ logger: false })
    const resetAt = new Date(Date.now() + 15 * 60 * 1000).toISOString()
    await getDb().execute(sql`
      INSERT INTO auth_rate_limit_buckets (bucket_key, request_count, reset_at)
      VALUES (${`email:${user.email}`}, 5, ${resetAt}::timestamptz)
      ON CONFLICT (bucket_key)
      DO UPDATE SET request_count = 5, reset_at = ${resetAt}::timestamptz, updated_at = NOW()
    `)

    const lastResponse = await app.inject({
      method: 'POST',
      url: MFA_RECOVER_URL,
      payload: { email: user.email, password: PASSWORD, recoveryCode: 'AAAAA-AAAAA' },
    })

    expect(lastResponse?.statusCode).toBe(429)
    expect(lastResponse?.headers['retry-after']).toBeDefined()
    expect(lastResponse?.json()).toMatchObject({
      code: 'rate_limit_exceeded',
      retryAfterSeconds: expect.any(Number),
    })
    await app.close()
  }, 45_000)

  it('deletes pending MFA enrollment when the session is revoked', async () => {
    const user = await registerAndLogin()
    const app = await createApp({ logger: false })
    const cookies = cookieHeader(user.cookies)
    await startEnrollment(app, cookies)

    const logout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: cookies },
    })
    expect(logout.statusCode).toBe(204)

    await expectNoPendingEnrollment(user.userId)
    await app.close()
  }, 45_000)
})
