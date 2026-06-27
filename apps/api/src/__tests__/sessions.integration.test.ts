import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  configureAuthIntegrationEnv,
  cookieHeader,
  initVaultForTest,
  parseSetCookies,
  type CookieJar,
} from './helpers/auth-test-helpers.js'

configureAuthIntegrationEnv()

const { createApp } = await import('../app.js')
const { initVault } = await import('../modules/vault/key-service.js')
const { resetVaultForTest } = await import('./helpers/vault-test-cleanup.js')

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
  const register = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email, password: PASSWORD, orgName },
  })
  expect(register.statusCode).toBe(201)

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password: PASSWORD },
  })
  expect(login.statusCode).toBe(200)
  await app.close()
  return { email, password: PASSWORD, cookies: parseSetCookies(login.headers['set-cookie']) }
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
      },
    })
    await app.close()
  })

  it('GET /auth/sessions lists current and second sessions with isCurrent', async () => {
    const user = await registerAndLogin('list')
    await loginAs(user.email, user.password)

    const sessions = await listSessions(user.cookies)

    expect(sessions).toHaveLength(2)
    expect(sessions.filter((session) => session.isCurrent)).toHaveLength(1)
  })

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

    const targetMe = await app.inject({
      method: 'GET',
      url: AUTH_ME_URL,
      headers: { cookie: cookieHeader(otherCookies) },
    })
    expect(targetMe.statusCode).toBe(401)
    expect(targetMe.json()).toMatchObject({ code: 'session_revoked' })
    await app.close()
  })

  it('DELETE /auth/sessions/:id for current session clears auth cookies', async () => {
    const user = await registerAndLogin('revoke-current')
    const currentSession = (await listSessions(user.cookies)).find((session) => session.isCurrent)
    expect(currentSession).toBeDefined()

    const app = await createApp({ logger: false })
    const revoke = await app.inject({
      method: 'DELETE',
      url: `/api/v1/auth/sessions/${currentSession?.sessionId}`,
      headers: { cookie: cookieHeader(user.cookies) },
    })

    expect(revoke.statusCode).toBe(204)
    const cleared = parseSetCookies(revoke.headers['set-cookie'])
    expect(cleared['access-token']).toBe('')
    expect(cleared['refresh-token']).toBe('')
    await app.close()
  })

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

    const currentMe = await app.inject({
      method: 'GET',
      url: AUTH_ME_URL,
      headers: { cookie: cookieHeader(user.cookies) },
    })
    expect(currentMe.statusCode).toBe(200)

    for (const jar of [second, third]) {
      const revokedMe = await app.inject({
        method: 'GET',
        url: AUTH_ME_URL,
        headers: { cookie: cookieHeader(jar) },
      })
      expect(revokedMe.statusCode).toBe(401)
      expect(revokedMe.json()).toMatchObject({ code: 'session_revoked' })
    }
    await app.close()
  })

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

    const me = await app.inject({
      method: 'GET',
      url: AUTH_ME_URL,
      headers: { cookie: cookieHeader(user.cookies) },
    })
    expect(me.statusCode).toBe(401)
    expect(me.json()).toMatchObject({ code: 'session_revoked' })
    await app.close()
  })
})
