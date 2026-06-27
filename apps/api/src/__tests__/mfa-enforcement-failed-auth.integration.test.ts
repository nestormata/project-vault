import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { desc, eq, sql } from 'drizzle-orm'
import { getDb, withOrg } from '@project-vault/db'
import {
  auditLogEntries,
  failedAuthAttempts,
  orgMemberships,
  securityAlerts,
  users,
} from '@project-vault/db/schema'
import {
  configureAuthIntegrationEnv,
  cookieHeader,
  initVaultForTest,
  parseSetCookies,
  type CookieJar,
} from './helpers/auth-test-helpers.js'
import { registerPrivilegedTestRoute } from './helpers/privileged-test-route.js'
import { runFailedAuthThresholdCheck } from '../workers/check-failed-auth-threshold.js'
import { pruneFailedAuthAttempts } from '../workers/prune-failed-auth-attempts.js'
import { SecurityAlertType } from '@project-vault/shared'

configureAuthIntegrationEnv()

const { createApp } = await import('../app.js')
const { initVault } = await import('../modules/vault/key-service.js')
const { resetVaultForTest } = await import('./helpers/vault-test-cleanup.js')

const PASSWORD = 'correct-horse-battery-staple'
const TEST_PASSPHRASE = 'mfa-enforcement-passphrase'
const PRIVILEGED_URL = '/api/v1/test/privileged-action'

type TestUser = {
  userId: string
  orgId: string
  cookies: CookieJar
}

async function registerAndLogin(label: string): Promise<TestUser> {
  const app = await createApp({ logger: false })
  registerPrivilegedTestRoute(app)
  const email = `mfa-enforcement-${label}-${randomUUID()}@example.com`
  const register = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email, password: PASSWORD, orgName: `MFA Enforcement ${label} ${randomUUID()}` },
  })
  expect(register.statusCode).toBe(201)
  const body = register.json<{ data: { userId: string; orgId: string } }>()

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password: PASSWORD },
  })
  expect(login.statusCode).toBe(200)
  await app.close()
  return {
    userId: body.data.userId,
    orgId: body.data.orgId,
    cookies: parseSetCookies(login.headers['set-cookie']),
  }
}

async function updateMembership(
  user: TestUser,
  values: Partial<typeof orgMemberships.$inferInsert>
): Promise<void> {
  await withOrg(user.orgId, (tx) =>
    tx.update(orgMemberships).set(values).where(eq(orgMemberships.userId, user.userId))
  )
}

async function postPrivileged(user: TestUser, logger: false | object = false) {
  const app = await createApp({ logger })
  registerPrivilegedTestRoute(app)
  const response = await app.inject({
    method: 'POST',
    url: PRIVILEGED_URL,
    headers: { cookie: cookieHeader(user.cookies) },
  })
  await app.close()
  return response
}

async function latestFailedAuthAttempt() {
  const [row] = await getDb()
    .select()
    .from(failedAuthAttempts)
    .orderBy(desc(failedAuthAttempts.attemptedAt))
    .limit(1)
  return row
}

describe.sequential('Story 1.9 MFA enforcement', () => {
  beforeAll(async () => {
    await resetVaultForTest()
    await initVaultForTest(initVault, TEST_PASSPHRASE)
  })

  afterAll(async () => {
    await resetVaultForTest()
  })

  it('allows privileged action during grace period and sets grace header', async () => {
    const user = await registerAndLogin('grace')

    const response = await postPrivileged(user)

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ ok: true, action: 'privileged_mock' })
    expect(response.headers['x-mfa-grace-expires-at']).toEqual(expect.any(String))
  })

  it('blocks privileged action when owner has no MFA and grace expired', async () => {
    const user = await registerAndLogin('expired-owner')
    await updateMembership(user, {
      gracePeriodExpiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    })

    const response = await postPrivileged(user)

    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ code: 'mfa_required' })
  })

  it('emits structured log when MFA enforcement denies a request', async () => {
    const user = await registerAndLogin('denial-log')
    const logs: string[] = []
    await updateMembership(user, {
      gracePeriodExpiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    })

    const response = await postPrivileged(user, {
      level: 'warn',
      stream: { write: (line: string) => logs.push(line) },
    })

    expect(response.statusCode).toBe(403)
    const joinedLogs = logs.join('\n')
    expect(joinedLogs).toContain('security.mfa_enrollment_required_denied')
    expect(joinedLogs).toContain(user.userId)
    expect(joinedLogs).toContain(user.orgId)
    expect(joinedLogs).not.toContain('gracePeriodExpiresAt')
  })

  it('allows privileged action when MFA is enrolled even if grace expired', async () => {
    const user = await registerAndLogin('enrolled')
    await updateMembership(user, {
      gracePeriodExpiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    })
    await getDb().update(users).set({ mfaEnrolledAt: new Date() }).where(eq(users.id, user.userId))

    const response = await postPrivileged(user)

    expect(response.statusCode).toBe(200)
  })

  it('returns insufficient_role for member before MFA enforcement', async () => {
    const user = await registerAndLogin('member')
    await updateMembership(user, {
      role: 'member',
      gracePeriodExpiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    })

    const response = await postPrivileged(user)

    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ code: 'insufficient_role' })
  })

  it('requires MFA on admin session revocation retrofit route', async () => {
    const user = await registerAndLogin('retrofit')
    await updateMembership(user, {
      gracePeriodExpiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    })
    const app = await createApp({ logger: false })

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/org/users/${user.userId}/sessions`,
      headers: { cookie: cookieHeader(user.cookies) },
    })

    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ code: 'mfa_required' })
    await app.close()
  })
})

describe.sequential('Story 1.9 failed auth recording', () => {
  beforeAll(async () => {
    await resetVaultForTest()
    await initVaultForTest(initVault, `${TEST_PASSPHRASE}-failed-auth`)
  })

  afterAll(async () => {
    await resetVaultForTest()
  })

  it('records invalid_credentials on failed login', async () => {
    await getDb().delete(failedAuthAttempts)
    const user = await registerAndLogin('failed-login')
    const app = await createApp({ logger: false })

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        email: `MFA-ENFORCEMENT-FAILED-LOGIN-${user.userId}@example.com`,
        password: 'wrong-password-here',
      },
    })

    expect(response.statusCode).toBe(401)
    expect(await latestFailedAuthAttempt()).toMatchObject({
      userId: null,
      reason: 'invalid_credentials',
    })
    await app.close()
  })

  it('records invalid_totp on verify-enrollment failure', async () => {
    await getDb().delete(failedAuthAttempts)
    const user = await registerAndLogin('invalid-totp')
    const app = await createApp({ logger: false })
    const cookies = cookieHeader(user.cookies)

    const enroll = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/enroll',
      headers: { cookie: cookies },
      payload: {},
    })
    expect(enroll.statusCode).toBe(200)

    const verify = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/verify-enrollment',
      headers: { cookie: cookies },
      payload: { totp: '000000' },
    })

    expect(verify.statusCode).toBe(422)
    expect(await latestFailedAuthAttempt()).toMatchObject({
      userId: user.userId,
      reason: 'invalid_totp',
    })
    await app.close()
  })

  it('creates a security alert and audit row when account threshold is exceeded', async () => {
    await getDb().delete(failedAuthAttempts)
    const user = await registerAndLogin('threshold')
    await withOrg(user.orgId, async (tx) => {
      await tx.delete(securityAlerts)
    })

    for (let index = 0; index < 10; index += 1) {
      await getDb()
        .insert(failedAuthAttempts)
        .values({
          userId: user.userId,
          ipAddress: '198.51.100.25',
          attemptedEmail: `threshold-${user.userId}@example.com`,
          reason: 'invalid_credentials',
        })
    }

    await runFailedAuthThresholdCheck()

    const alerts = await withOrg(user.orgId, (tx) => tx.select().from(securityAlerts))
    const audits = await withOrg(user.orgId, (tx) => tx.select().from(auditLogEntries))

    expect(alerts).toHaveLength(2)
    expect(alerts.map((alert) => alert.alertType)).toEqual([
      SecurityAlertType.FAILED_AUTH_THRESHOLD,
      SecurityAlertType.FAILED_AUTH_THRESHOLD,
    ])
    expect(
      audits.some((audit) => audit.eventType === SecurityAlertType.FAILED_AUTH_THRESHOLD)
    ).toBe(true)

    const app = await createApp({ logger: false })
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/org/security-alerts?status=PENDING_DELIVERY',
      headers: { cookie: cookieHeader(user.cookies) },
    })
    expect(list.statusCode).toBe(200)
    expect(list.json()).toMatchObject({
      data: {
        total: 2,
        items: [
          {
            alertType: SecurityAlertType.FAILED_AUTH_THRESHOLD,
            status: 'PENDING_DELIVERY',
            deliveryStatus: 'pending_notification_channel',
          },
          {
            alertType: SecurityAlertType.FAILED_AUTH_THRESHOLD,
            status: 'PENDING_DELIVERY',
            deliveryStatus: 'pending_notification_channel',
          },
        ],
      },
    })
    await app.close()
  })

  it('rejects member access to security alerts', async () => {
    const user = await registerAndLogin('member-alerts')
    await updateMembership(user, { role: 'member' })
    const app = await createApp({ logger: false })

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/org/security-alerts',
      headers: { cookie: cookieHeader(user.cookies) },
    })

    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ code: 'insufficient_role' })
    await app.close()
  })

  it('prunes failed auth attempts older than retention while keeping recent rows', async () => {
    await getDb().delete(failedAuthAttempts)
    const oldAttemptAt = new Date(Date.now() - 25 * 60 * 60 * 1000)
    const recentAttemptAt = new Date(Date.now() - 23 * 60 * 60 * 1000)
    await getDb()
      .insert(failedAuthAttempts)
      .values([
        {
          ipAddress: '198.51.100.30',
          attemptedEmail: 'old@example.com',
          reason: 'invalid_credentials',
          attemptedAt: oldAttemptAt,
        },
        {
          ipAddress: '198.51.100.31',
          attemptedEmail: 'recent@example.com',
          reason: 'invalid_credentials',
          attemptedAt: recentAttemptAt,
        },
      ])

    await pruneFailedAuthAttempts()

    const rows = await getDb()
      .select({ attemptedEmail: failedAuthAttempts.attemptedEmail })
      .from(failedAuthAttempts)
      .where(sql`${failedAuthAttempts.attemptedEmail} IN ('old@example.com', 'recent@example.com')`)

    expect(rows).toEqual([{ attemptedEmail: 'recent@example.com' }])
  })
})
