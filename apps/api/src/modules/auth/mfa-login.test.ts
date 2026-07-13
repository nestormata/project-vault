import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'
import { getDb, withOrg } from '@project-vault/db'
import { AuditEvent } from '@project-vault/shared'
import { auditLogEntries, failedAuthAttempts, pendingMfaSessions } from '@project-vault/db/schema'
import { env } from '../../config/env.js'
import * as tokensModule from './tokens.js'
import {
  configureAuthIntegrationEnv,
  initVaultForTest,
  parseSetCookies,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { enrollUserWithMfa } from '../../__tests__/helpers/mfa-enroll-test-helpers.js'
import { totpForSecret } from '../../__tests__/helpers/totp.js'

configureAuthIntegrationEnv()
// Most tests here enroll MFA (Argon2 hashing + multiple createApp() round trips) and can
// exceed vitest's 5s default under the concurrent cross-package load of `make ci`/`pnpm test`.
vi.setConfig({ testTimeout: 45_000 })

const { createApp } = await import('../../app.js')
const { initVault } = await import('../vault/key-service.js')
const { resetVaultForTest } = await import('../../__tests__/helpers/vault-test-cleanup.js')
const { loginUser } = await import('./service.js')
const { createPendingMfaSession, verifyLogin } = await import('./mfa-login.js')
const { hashPendingMfaToken } = await import('./tokens.js')

const PASSWORD = 'correct-horse-battery-staple'
const TEST_PASSPHRASE = 'mfa-login-tests-passphrase'
const AUTH_LOGIN_URL = '/api/v1/auth/login'
const EXPECTED_MFA_CHALLENGE = 'expected MFA challenge'
const INVALID_TOTP_CODE = '000000'
const MFA_TOKEN_EXPIRED = 'mfa_token_expired'
const INVALID_TOTP = 'invalid_totp'

async function enrollMfaUser() {
  const app = await createApp({ logger: false })
  // enrollUserWithMfa() returns the exact TOTP code it used to confirm enrollment — reuse it
  // (rather than calling totpForSecret() again here) so "replay" tests replay a code that was
  // actually consumed, not a fresh one from a possibly-later 30s TOTP period.
  return enrollUserWithMfa(app, {
    emailPrefix: 'mfa-login',
    orgNamePrefix: 'MFA Login',
    password: PASSWORD,
    closeApp: true,
  })
}

async function failedTotpRowsForUser(userId: string) {
  return getDb()
    .select()
    .from(failedAuthAttempts)
    .where(
      and(eq(failedAuthAttempts.userId, userId), eq(failedAuthAttempts.reason, 'invalid_totp'))
    )
}

async function waitForFailedTotpRows(userId: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const rows = await failedTotpRowsForUser(userId)
    if (rows.length > 0) return rows
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return failedTotpRowsForUser(userId)
}

async function challengeForEnrolledUser() {
  const user = await enrollMfaUser()
  const challenge = await loginUser({ email: user.email, password: PASSWORD })
  if (!('mfaRequired' in challenge)) throw new Error(EXPECTED_MFA_CHALLENGE)
  return { user, challenge }
}

async function auditRowsForEvent(orgId: string, eventType: string) {
  return withOrg(orgId, (tx) =>
    tx
      .select({ eventType: auditLogEntries.eventType, payload: auditLogEntries.payload })
      .from(auditLogEntries)
      .where(and(eq(auditLogEntries.orgId, orgId), eq(auditLogEntries.eventType, eventType)))
  )
}

async function expectInvalidLoginTotpRecorded(
  user: { userId: string; email: string; orgId: string },
  ipAddress: string
) {
  const rows = await waitForFailedTotpRows(user.userId)
  expect(rows).toHaveLength(1)
  expect(rows[0]?.attemptedEmail).toBe(user.email)
  expect(rows[0]?.ipAddress).toBe(ipAddress)

  const auditRows = await auditRowsForEvent(user.orgId, AuditEvent.LOGIN_FAILED)
  expect(auditRows).toContainEqual({
    eventType: AuditEvent.LOGIN_FAILED,
    payload: { method: 'totp_login' },
  })
}

describe.sequential('MFA login service', () => {
  beforeAll(async () => {
    await resetVaultForTest()
    await initVaultForTest(initVault, TEST_PASSPHRASE)
  })

  beforeEach(async () => {
    await getDb().execute(sql`DELETE FROM auth_rate_limit_buckets`)
    await getDb().execute(sql`DELETE FROM pending_mfa_sessions`)
    await getDb().execute(sql`DELETE FROM failed_auth_attempts`)
  })

  afterAll(async () => {
    await resetVaultForTest()
  })

  it('returns an MFA challenge for enrolled users and stores only the token hash', async () => {
    const user = await enrollMfaUser()

    const result = await loginUser(
      { email: user.email, password: PASSWORD },
      { ipAddress: '203.0.113.10', userAgent: 'mfa-login-test' }
    )

    expect(result).toMatchObject({ mfaRequired: true, mfaToken: expect.any(String) })
    if (!('mfaRequired' in result)) throw new Error(EXPECTED_MFA_CHALLENGE)

    const rows = await getDb()
      .select()
      .from(pendingMfaSessions)
      .where(
        and(eq(pendingMfaSessions.userId, user.userId), eq(pendingMfaSessions.orgId, user.orgId))
      )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.tokenHash).toBe(hashPendingMfaToken(result.mfaToken))
    expect(rows[0]?.tokenHash).not.toBe(result.mfaToken)
    expect(rows[0]?.attemptCount).toBe(0)
    expect(rows[0]?.userAgent).toBe('mfa-login-test')
  })

  it('returns an MFA challenge from the login route without usable auth cookies', async () => {
    const user = await enrollMfaUser()
    const app = await createApp({ logger: false })

    const response = await app.inject({
      method: 'POST',
      url: AUTH_LOGIN_URL,
      headers: { cookie: 'access-token=stale-access; refresh-token=stale-refresh' },
      payload: { email: user.email, password: PASSWORD },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      data: { mfaRequired: true, mfaToken: expect.any(String) },
    })
    const cookies = parseSetCookies(response.headers['set-cookie'])
    expect(cookies['access-token']).toBe('')
    expect(cookies['refresh-token']).toBe('')

    await app.close()
  })

  it('keeps non-MFA login unchanged and rejects invalid MFA-user passwords without leaking a token', async () => {
    const app = await createApp({ logger: false })
    const email = `non-mfa-${randomUUID()}@example.com`
    const register = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, password: PASSWORD, orgName: `Non MFA ${randomUUID()}` },
    })
    expect(register.statusCode).toBe(201)

    const login = await app.inject({
      method: 'POST',
      url: AUTH_LOGIN_URL,
      payload: { email, password: PASSWORD },
    })
    expect(login.statusCode).toBe(200)
    expect(login.json()).toMatchObject({
      data: { userId: expect.any(String), orgId: expect.any(String) },
    })
    expect(parseSetCookies(login.headers['set-cookie'])['access-token']).toBeTruthy()

    await app.close()

    const mfaUser = await enrollMfaUser()
    const appForMfa = await createApp({ logger: false })
    const invalid = await appForMfa.inject({
      method: 'POST',
      url: AUTH_LOGIN_URL,
      payload: { email: mfaUser.email, password: 'wrong-password-value' },
    })
    expect(invalid.statusCode).toBe(401)
    expect(JSON.stringify(invalid.json())).not.toContain('mfaToken')
    await appForMfa.close()
  })

  it('verifies a pending MFA login, issues a session, and consumes the token', async () => {
    const { user, challenge } = await challengeForEnrolledUser()

    const session = await verifyLogin({
      mfaToken: challenge.mfaToken,
      totp: totpForSecret(user.secret, Date.now() + 30_000),
    })

    expect(session).toMatchObject({
      userId: user.userId,
      orgId: user.orgId,
      expiresAt: expect.any(String),
      tokens: expect.any(Object),
    })
    await expect(
      getDb().select().from(pendingMfaSessions).where(eq(pendingMfaSessions.userId, user.userId))
    ).resolves.toHaveLength(0)
    await expect(
      verifyLogin({
        mfaToken: challenge.mfaToken,
        totp: totpForSecret(user.secret, Date.now() + 30_000),
      })
    ).rejects.toMatchObject({ code: MFA_TOKEN_EXPIRED, statusCode: 401 })

    const auditRows = await auditRowsForEvent(user.orgId, AuditEvent.MFA_LOGIN_VERIFIED)
    expect(auditRows).toContainEqual({
      eventType: AuditEvent.MFA_LOGIN_VERIFIED,
      payload: { method: 'totp' },
    })
  })

  it('invalidates the previous pending token when a newer challenge is created', async () => {
    const user = await enrollMfaUser()
    const first = await loginUser({ email: user.email, password: PASSWORD })
    const second = await loginUser({ email: user.email, password: PASSWORD })
    if (!('mfaRequired' in first) || !('mfaRequired' in second)) {
      throw new Error(EXPECTED_MFA_CHALLENGE)
    }

    await expect(
      verifyLogin({
        mfaToken: first.mfaToken,
        totp: totpForSecret(user.secret, Date.now() + 30_000),
      })
    ).rejects.toMatchObject({ code: MFA_TOKEN_EXPIRED, statusCode: 401 })
    await expect(
      getDb()
        .select()
        .from(pendingMfaSessions)
        .where(
          and(eq(pendingMfaSessions.userId, user.userId), eq(pendingMfaSessions.orgId, user.orgId))
        )
    ).resolves.toHaveLength(1)
  })

  it('returns the same expired error for unknown, expired, and attempt-capped tokens', async () => {
    await expect(
      verifyLogin({ mfaToken: 'unknown-mfa-token-value', totp: '123456' })
    ).rejects.toMatchObject({
      code: MFA_TOKEN_EXPIRED,
      statusCode: 401,
    })

    const expiredUser = await enrollMfaUser()
    const expiredChallenge = await loginUser({ email: expiredUser.email, password: PASSWORD })
    if (!('mfaRequired' in expiredChallenge)) throw new Error(EXPECTED_MFA_CHALLENGE)
    await getDb()
      .update(pendingMfaSessions)
      .set({
        createdAt: new Date(Date.now() - 10 * 60_000),
        expiresAt: new Date(Date.now() - 60_000),
      })
      .where(eq(pendingMfaSessions.tokenHash, hashPendingMfaToken(expiredChallenge.mfaToken)))
    await expect(
      verifyLogin({
        mfaToken: expiredChallenge.mfaToken,
        totp: totpForSecret(expiredUser.secret, Date.now() + 30_000),
      })
    ).rejects.toMatchObject({ code: MFA_TOKEN_EXPIRED, statusCode: 401 })

    const cappedUser = await enrollMfaUser()
    const cappedChallenge = await loginUser({ email: cappedUser.email, password: PASSWORD })
    if (!('mfaRequired' in cappedChallenge)) throw new Error(EXPECTED_MFA_CHALLENGE)
    for (let attempt = 1; attempt <= env.MFA_LOGIN_MAX_ATTEMPTS; attempt += 1) {
      const expectedCode = attempt === env.MFA_LOGIN_MAX_ATTEMPTS ? MFA_TOKEN_EXPIRED : INVALID_TOTP
      const expectedStatus = attempt === env.MFA_LOGIN_MAX_ATTEMPTS ? 401 : 422
      await expect(
        verifyLogin({ mfaToken: cappedChallenge.mfaToken, totp: INVALID_TOTP_CODE })
      ).rejects.toMatchObject({ code: expectedCode, statusCode: expectedStatus })
    }
    await expect(
      getDb()
        .select()
        .from(pendingMfaSessions)
        .where(eq(pendingMfaSessions.tokenHash, hashPendingMfaToken(cappedChallenge.mfaToken)))
    ).resolves.toHaveLength(0)
  }, 90_000)

  it('records invalid_totp failed-auth attempts for wrong login TOTP codes', async () => {
    const { user, challenge } = await challengeForEnrolledUser()

    await expect(
      verifyLogin(
        { mfaToken: challenge.mfaToken, totp: INVALID_TOTP_CODE },
        { ipAddress: '203.0.113.11' }
      )
    ).rejects.toMatchObject({ code: INVALID_TOTP, statusCode: 422 })

    await expectInvalidLoginTotpRecorded(user, '203.0.113.11')
  })

  it('records the invalid TOTP attempt that consumes a capped login challenge', async () => {
    const previousMaxAttempts = env.MFA_LOGIN_MAX_ATTEMPTS
    env.MFA_LOGIN_MAX_ATTEMPTS = 1
    try {
      const { user, challenge } = await challengeForEnrolledUser()

      await expect(
        verifyLogin(
          { mfaToken: challenge.mfaToken, totp: INVALID_TOTP_CODE },
          { ipAddress: '203.0.113.12' }
        )
      ).rejects.toMatchObject({ code: MFA_TOKEN_EXPIRED, statusCode: 401 })

      await expectInvalidLoginTotpRecorded(user, '203.0.113.12')
    } finally {
      env.MFA_LOGIN_MAX_ATTEMPTS = previousMaxAttempts
    }
  })

  it('does not record failed-auth attempts for replayed login TOTP codes', async () => {
    const { user, challenge } = await challengeForEnrolledUser()

    await expect(
      verifyLogin({ mfaToken: challenge.mfaToken, totp: user.enrollmentTotp })
    ).rejects.toMatchObject({ code: INVALID_TOTP, statusCode: 422 })

    const rows = await failedTotpRowsForUser(user.userId)
    expect(rows).toHaveLength(0)
  })

  it('does not emit mfaToken, tokenHash, totp, or TOTP secret in lifecycle logs', async () => {
    const { user, challenge } = await challengeForEnrolledUser()
    const written: string[] = []
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        written.push(String(chunk))
        return true
      })
    try {
      await expect(
        verifyLogin({ mfaToken: challenge.mfaToken, totp: INVALID_TOTP_CODE })
      ).rejects.toMatchObject({ code: INVALID_TOTP })
    } finally {
      stdoutSpy.mockRestore()
    }
    const logs = written.join('\n')
    expect(logs).not.toContain(challenge.mfaToken)
    expect(logs).not.toContain(hashPendingMfaToken(challenge.mfaToken))
    expect(logs).not.toContain(INVALID_TOTP_CODE)
    expect(logs).not.toContain(user.secret)
  })

  it('allows exactly one of two concurrent verify-login requests for the same valid token to succeed', async () => {
    const { user, challenge } = await challengeForEnrolledUser()
    const totp = totpForSecret(user.secret, Date.now() + 30_000)

    const results = await Promise.allSettled([
      verifyLogin({ mfaToken: challenge.mfaToken, totp }),
      verifyLogin({ mfaToken: challenge.mfaToken, totp }),
    ])

    const fulfilled = results.filter((result) => result.status === 'fulfilled')
    const rejected = results.filter((result) => result.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: MFA_TOKEN_EXPIRED,
      statusCode: 401,
    })
    await expect(
      getDb().select().from(pendingMfaSessions).where(eq(pendingMfaSessions.userId, user.userId))
    ).resolves.toHaveLength(0)
  })

  it('retries token generation on a token_hash collision and never returns the collided token', async () => {
    const user = await enrollMfaUser()
    const otherUser = await enrollMfaUser()
    const collidedToken = 'a'.repeat(22)
    const collidedHash = hashPendingMfaToken(collidedToken)

    await getDb()
      .insert(pendingMfaSessions)
      .values({
        userId: otherUser.userId,
        orgId: otherUser.orgId,
        tokenHash: collidedHash,
        attemptCount: 0,
        expiresAt: new Date(Date.now() + 5 * 60_000),
      })

    const generateSpy = vi
      .spyOn(tokensModule, 'generatePendingMfaToken')
      .mockReturnValueOnce(collidedToken)

    try {
      const challenge = await createPendingMfaSession({ userId: user.userId, orgId: user.orgId })

      expect(challenge.mfaToken).not.toBe(collidedToken)
      expect(generateSpy).toHaveBeenCalledTimes(2)
      const rows = await getDb()
        .select()
        .from(pendingMfaSessions)
        .where(eq(pendingMfaSessions.tokenHash, hashPendingMfaToken(challenge.mfaToken)))
      expect(rows).toHaveLength(1)
      expect(rows[0]?.userId).toBe(user.userId)
    } finally {
      generateSpy.mockRestore()
    }
  })
})
