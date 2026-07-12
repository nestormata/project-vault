import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { orgMemberships, sessions } from '@project-vault/db/schema'
import { env } from '../config/env.js'
import {
  configureAuthIntegrationEnv,
  cookieHeader,
  initVaultForTest,
  parseSetCookies,
  registerAndLoginViaApi,
  type CookieJar,
} from './helpers/auth-test-helpers.js'

configureAuthIntegrationEnv()

const { createApp } = await import('../app.js')
const { initVault } = await import('../modules/vault/key-service.js')
const { createLoginSessionInTx } = await import('../modules/auth/service.js')
const { firstActorTokenIdForUser } = await import('../modules/audit/actor-token.js')
const { resetVaultForTest } = await import('./helpers/vault-test-cleanup.js')
const { evictSessionActivityDebounce } = await import('../modules/auth/session-activity.js')

type TestApp = Awaited<ReturnType<typeof createApp>>

const TEST_PASSPHRASE = 'session-tests-passphrase'
const PASSWORD = 'correct-horse-battery-staple'
const AUTH_ME_URL = '/api/v1/auth/me'

type SessionSummary = {
  sessionId: string
  isCurrent: boolean
}

function uniqueEmail(label: string): string {
  return `session-${label}-${randomUUID()}@example.com`
}

async function registerAndLogin(label: string) {
  const app = await createApp({ logger: false })
  const email = uniqueEmail(label)
  const orgName = `Session Test ${label} ${randomUUID()}`
  const { userId, orgId, cookies } = await registerAndLoginViaApi(app, {
    email,
    password: PASSWORD,
    orgName,
  })
  await app.close()
  return { userId, orgId, email, password: PASSWORD, cookies }
}

async function loginAs(email: string, password: string): Promise<CookieJar> {
  const app = await createApp({ logger: false })
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password },
  })
  expect(login.statusCode).toBe(200)
  await app.close()
  return parseSetCookies(login.headers['set-cookie'])
}

async function listSessions(jar: CookieJar): Promise<SessionSummary[]> {
  const app = await createApp({ logger: false })
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/auth/sessions',
    headers: { cookie: cookieHeader(jar) },
  })
  expect(res.statusCode).toBe(200)
  await app.close()
  return res.json<{ data: SessionSummary[] }>().data
}

async function refreshWith(jar: CookieJar) {
  const app = await createApp({ logger: false })
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/refresh',
    headers: { cookie: cookieHeader(jar) },
  })
  await app.close()
  return response
}

async function expectAuthMe(
  app: TestApp,
  jar: CookieJar,
  statusCode: number,
  code?: string
): Promise<void> {
  const response = await app.inject({
    method: 'GET',
    url: AUTH_ME_URL,
    headers: { cookie: cookieHeader(jar) },
  })
  expect(response.statusCode).toBe(statusCode)
  if (code) expect(response.json()).toMatchObject({ code })
}

async function revokeCurrentSession(app: TestApp, jar: CookieJar) {
  const currentSession = (await listSessions(jar)).find((session) => session.isCurrent)
  expect(currentSession).toBeDefined()
  return app.inject({
    method: 'DELETE',
    url: `/api/v1/auth/sessions/${currentSession?.sessionId}`,
    headers: { cookie: cookieHeader(jar) },
  })
}

describe.sequential('Session management integration', () => {
  beforeAll(async () => {
    await resetVaultForTest()
    await initVaultForTest(initVault, TEST_PASSPHRASE)
  })

  afterAll(async () => {
    await resetVaultForTest()
  })

  it('GET /auth/me returns auth context for a logged-in user', async () => {
    const user = await registerAndLogin('me')
    const app = await createApp({ logger: false })
    const res = await app.inject({
      method: 'GET',
      url: AUTH_ME_URL,
      headers: { cookie: cookieHeader(user.cookies) },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      data: {
        userId: expect.any(String),
        orgId: expect.any(String),
        sessionId: expect.any(String),
        orgRole: 'owner',
        mfaEnrolled: false,
        mfaStatus: {
          enrollmentRequired: false,
          gracePeriodActive: true,
          gracePeriodExpiresAt: expect.any(String),
          gracePeriodDaysRemaining: expect.any(Number),
          bannerMessage: expect.stringContaining('MFA enrollment is required'),
        },
      },
    })
    await app.close()
  }, 60_000)

  it('registration sets a seven-day MFA grace period for the owner membership', async () => {
    const user = await registerAndLogin('grace-period')

    const [membership] = await withOrg(user.orgId, (tx) =>
      tx
        .select({
          role: orgMemberships.role,
          gracePeriodExpiresAt: orgMemberships.gracePeriodExpiresAt,
        })
        .from(orgMemberships)
        .where(eq(orgMemberships.userId, user.userId))
        .limit(1)
    )

    expect(membership?.role).toBe('owner')
    expect(membership?.gracePeriodExpiresAt).toBeInstanceOf(Date)
    if (!membership?.gracePeriodExpiresAt) {
      throw new Error('expected membership grace period to be set')
    }
    const daysUntil = Math.ceil(
      (membership.gracePeriodExpiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000)
    )
    expect(daysUntil).toBeGreaterThanOrEqual(6)
    expect(daysUntil).toBeLessThanOrEqual(7)
  }, 60_000)

  it('GET /auth/sessions lists current and second sessions with isCurrent', async () => {
    const user = await registerAndLogin('list')
    await loginAs(user.email, user.password)

    const sessions = await listSessions(user.cookies)

    expect(sessions).toHaveLength(2)
    expect(sessions.filter((session) => session.isCurrent)).toHaveLength(1)
  }, 60_000)

  it('DELETE /auth/sessions/:id revokes another session and target cookie is rejected', async () => {
    const user = await registerAndLogin('revoke-other')
    const otherCookies = await loginAs(user.email, user.password)
    const otherSession = (await listSessions(otherCookies)).find((session) => session.isCurrent)
    expect(otherSession).toBeDefined()

    const app = await createApp({ logger: false })
    const revoke = await app.inject({
      method: 'DELETE',
      url: `/api/v1/auth/sessions/${otherSession?.sessionId}`,
      headers: { cookie: cookieHeader(user.cookies) },
    })
    expect(revoke.statusCode).toBe(204)

    await expectAuthMe(app, otherCookies, 401, 'session_revoked')
    await app.close()
  }, 60_000)

  it('DELETE /auth/sessions/:id for current session clears auth cookies', async () => {
    const user = await registerAndLogin('revoke-current')
    const app = await createApp({ logger: false })
    const revoke = await revokeCurrentSession(app, user.cookies)

    expect(revoke.statusCode).toBe(204)
    const cleared = parseSetCookies(revoke.headers['set-cookie'])
    expect(cleared['access-token']).toBe('')
    expect(cleared['refresh-token']).toBe('')
    await app.close()
  }, 60_000)

  it('DELETE /auth/sessions revokes all sessions except current', async () => {
    const user = await registerAndLogin('revoke-all-other')
    const second = await loginAs(user.email, user.password)
    const third = await loginAs(user.email, user.password)

    const app = await createApp({ logger: false })
    const revoke = await app.inject({
      method: 'DELETE',
      url: '/api/v1/auth/sessions',
      headers: { cookie: cookieHeader(user.cookies) },
    })
    expect(revoke.statusCode).toBe(200)
    expect(revoke.json()).toMatchObject({ data: { revokedCount: 2 } })

    await expectAuthMe(app, user.cookies, 200)

    for (const jar of [second, third]) {
      await expectAuthMe(app, jar, 401, 'session_revoked')
    }
    await app.close()
  }, 60_000)

  it('POST /auth/logout revokes current session and clears auth cookies', async () => {
    const user = await registerAndLogin('logout')
    const app = await createApp({ logger: false })
    const logout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: cookieHeader(user.cookies) },
    })

    expect(logout.statusCode).toBe(204)
    const cleared = parseSetCookies(logout.headers['set-cookie'])
    expect(cleared['access-token']).toBe('')
    expect(cleared['refresh-token']).toBe('')

    await expectAuthMe(app, user.cookies, 401, 'session_revoked')
    await app.close()
  }, 60_000)

  it('refresh rotation revokes the predecessor access token and allows grace retry', async () => {
    const user = await registerAndLogin('refresh-rotation')

    const refresh = await refreshWith(user.cookies)
    expect(refresh.statusCode).toBe(200)
    const rotatedCookies = parseSetCookies(refresh.headers['set-cookie'])
    expect(rotatedCookies['access-token']).toEqual(expect.any(String))
    expect(rotatedCookies['refresh-token']).toEqual(expect.any(String))

    const app = await createApp({ logger: false })
    await expectAuthMe(app, user.cookies, 401, 'session_revoked')
    await app.close()

    const graceRetry = await refreshWith(user.cookies)
    expect(graceRetry.statusCode).toBe(200)
    const graceCookies = parseSetCookies(graceRetry.headers['set-cookie'])
    expect(graceCookies['access-token']).toEqual(expect.any(String))
    expect(graceCookies['refresh-token']).toBeUndefined()
  }, 60_000)

  it('refresh rejects revoked sessions', async () => {
    const user = await registerAndLogin('refresh-revoked')
    const app = await createApp({ logger: false })
    const revoke = await revokeCurrentSession(app, user.cookies)
    expect(revoke.statusCode).toBe(204)
    await app.close()

    const refresh = await refreshWith(user.cookies)
    expect(refresh.statusCode).toBe(401)
    expect(refresh.json()).toMatchObject({ code: 'refresh_token_revoked' })
  }, 60_000)

  it('refresh idle timeout synchronously revokes the session', async () => {
    const user = await registerAndLogin('refresh-idle')
    const currentSession = (await listSessions(user.cookies)).find((session) => session.isCurrent)
    expect(currentSession).toBeDefined()

    await withOrg(user.orgId, async (tx) => {
      await tx
        .update(sessions)
        .set({
          lastActiveAt: new Date(Date.now() - (env.SESSION_IDLE_TIMEOUT_MINUTES + 1) * 60 * 1000),
        })
        .where(eq(sessions.id, currentSession?.sessionId as string))
    })

    const refresh = await refreshWith(user.cookies)
    expect(refresh.statusCode).toBe(401)
    expect(refresh.json()).toMatchObject({ code: 'session_expired' })

    const [session] = await withOrg(user.orgId, (tx) =>
      tx
        .select({ revokedAt: sessions.revokedAt })
        .from(sessions)
        .where(eq(sessions.id, currentSession?.sessionId as string))
        .limit(1)
    )
    expect(session?.revokedAt).toBeInstanceOf(Date)
  }, 60_000)

  it('an authenticated request refreshes the session lastActiveAt in the database', async () => {
    const user = await registerAndLogin('activity-touch')
    const currentSession = (await listSessions(user.cookies)).find((session) => session.isCurrent)
    expect(currentSession).toBeDefined()
    const sessionId = currentSession?.sessionId as string

    const stale = new Date(Date.now() - 120_000)
    await withOrg(user.orgId, (tx) =>
      tx.update(sessions).set({ lastActiveAt: stale }).where(eq(sessions.id, sessionId))
    )
    // listSessions() above already authenticated once and debounced this session's touch —
    // evict it so the next authenticated request below isn't skipped by the debounce window.
    evictSessionActivityDebounce(sessionId)

    const app = await createApp({ logger: false })
    await expectAuthMe(app, user.cookies, 200)
    await app.close()

    const [session] = await withOrg(user.orgId, (tx) =>
      tx
        .select({ lastActiveAt: sessions.lastActiveAt })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1)
    )
    expect(session?.lastActiveAt).toBeInstanceOf(Date)
    expect(session?.lastActiveAt.getTime()).not.toBe(stale.getTime())
    expect(Date.now() - (session?.lastActiveAt as Date).getTime()).toBeLessThan(20_000)
  }, 60_000)

  it('org owner can revoke all sessions for a user in the org', async () => {
    const admin = await registerAndLogin('admin-revoke-admin')
    const target = await registerAndLogin('admin-revoke-target')
    const targetSession = await withOrg(admin.orgId, async (tx) => {
      await tx.insert(orgMemberships).values({
        orgId: admin.orgId,
        userId: target.userId,
        role: 'member',
        status: 'active',
      })
      // Story 8.1: look up target's real identity token (registerAndLoginViaApi already
      // minted one) instead of hardcoding identityTokenId: null — a null actor_token_id on
      // this actor_type='human' SESSION_CREATED row permanently fails
      // checkAuditActorTokenCoverage, since audit_log_entries is append-only.
      const identityTokenId = await firstActorTokenIdForUser(tx, target.userId)
      return createLoginSessionInTx(tx, { id: target.userId, identityTokenId }, admin.orgId, {})
    })

    const app = await createApp({ logger: false })
    const revoke = await app.inject({
      method: 'DELETE',
      url: `/api/v1/org/users/${target.userId}/sessions`,
      headers: { cookie: cookieHeader(admin.cookies) },
    })
    expect(revoke.statusCode).toBe(200)
    expect(revoke.json()).toMatchObject({
      data: { revokedCount: 1, userId: target.userId },
    })
    await app.close()

    const [session] = await withOrg(admin.orgId, (tx) =>
      tx
        .select({ revokedAt: sessions.revokedAt })
        .from(sessions)
        .where(eq(sessions.jti, targetSession.tokens.accessClaims.jti))
        .limit(1)
    )
    expect(session?.revokedAt).toBeInstanceOf(Date)
  }, 60_000)

  it('MAX_SESSIONS_PER_USER revokes oldest sessions on login when configured', async () => {
    const previousLimit = env.MAX_SESSIONS_PER_USER
    env.MAX_SESSIONS_PER_USER = 2
    try {
      const user = await registerAndLogin('max-sessions')
      await loginAs(user.email, user.password)
      const latest = await loginAs(user.email, user.password)

      const active = await listSessions(latest)
      expect(active).toHaveLength(2)

      const app = await createApp({ logger: false })
      await expectAuthMe(app, user.cookies, 401, 'session_revoked')
      await app.close()
    } finally {
      env.MAX_SESSIONS_PER_USER = previousLimit
    }
  }, 60_000)
})
