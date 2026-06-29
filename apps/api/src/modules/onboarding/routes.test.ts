import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { auditLogEntries, userIdentityTokens, userOnboarding } from '@project-vault/db/schema'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  expectAuditWriteFailed,
  registerAndLoginViaApi,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { createUnsealedRouteSuite } from '../../__tests__/helpers/unsealed-route-suite-test-helpers.js'
import {
  createDirectAuthenticatedUser,
  loginExistingUserInOrg,
} from '../../__tests__/helpers/org-role-test-helpers.js'

const { initVault, humanAudit } = await bootstrapRouteIntegrationTest()
import type { createApp } from '../../app.js'

type TestApp = Awaited<ReturnType<typeof createApp>>
type TestUser = Awaited<ReturnType<typeof registerUser>>

const TEST_PASSPHRASE = 'onboarding-routes-passphrase'
const PASSWORD = 'correct-horse-battery-staple'
const ONBOARDING_URL = '/api/v1/users/me/onboarding'
const FORCED_AUDIT_FAILURE = 'forced audit failure'
const ONBOARDING_COMPLETED_EVENT = 'onboarding.completed'

function uniqueEmail(label: string): string {
  return `onboarding-${label}-${randomUUID()}@example.com`
}

async function registerUser(app: TestApp, label: string) {
  return registerAndLoginViaApi(app, {
    email: uniqueEmail(label),
    password: PASSWORD,
    orgName: `Onboarding ${label} ${randomUUID()}`,
  })
}

async function postOnboarding(app: TestApp, cookies: TestUser['cookies'], completed = true) {
  return app.inject({
    method: 'POST',
    url: ONBOARDING_URL,
    headers: { cookie: cookieHeader(cookies) },
    payload: { completed },
  })
}

async function getOnboarding(app: TestApp, cookies: TestUser['cookies']) {
  return app.inject({
    method: 'GET',
    url: ONBOARDING_URL,
    headers: { cookie: cookieHeader(cookies) },
  })
}

async function listOnboardingRows(user: TestUser) {
  return withOrg(user.orgId, (tx) =>
    tx
      .select()
      .from(userOnboarding)
      .where(and(eq(userOnboarding.userId, user.userId), eq(userOnboarding.orgId, user.orgId)))
  )
}

describe.sequential('onboarding routes', () => {
  const suite = createUnsealedRouteSuite(initVault, TEST_PASSPHRASE)
  suite.registerLifecycle()

  it('GET returns completed: false for a new user with no onboarding row', async () => {
    const user = await registerUser(suite.app, 'get-new')
    const res = await getOnboarding(suite.app, user.cookies)

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ completed: false })
    expect(await listOnboardingRows(user)).toHaveLength(0)
  }, 20_000)

  it('GET returns completed: true with completedAt for a completed user', async () => {
    const user = await registerUser(suite.app, 'get-completed')
    const post = await postOnboarding(suite.app, user.cookies)
    expect(post.statusCode).toBe(200)
    const posted = post.json<{ completed: true; completedAt: string }>()

    const res = await getOnboarding(suite.app, user.cookies)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ completed: true, completedAt: posted.completedAt })
  }, 20_000)

  it('GET returns 401 when unauthenticated', async () => {
    const res = await suite.app.inject({ method: 'GET', url: ONBOARDING_URL })
    expect(res.statusCode).toBe(401)
  })

  it('GET isolates onboarding state per user within the same org', async () => {
    const owner = await registerUser(suite.app, 'isolation-owner')
    const member = await createDirectAuthenticatedUser(suite.app, 'isolation-member')
    const memberCookies = await loginExistingUserInOrg(suite.app, {
      userId: member.userId,
      orgId: owner.orgId,
      role: 'member',
    })

    expect((await postOnboarding(suite.app, owner.cookies)).statusCode).toBe(200)
    expect((await getOnboarding(suite.app, owner.cookies)).json()).toMatchObject({
      completed: true,
    })
    expect((await getOnboarding(suite.app, memberCookies)).json()).toEqual({ completed: false })
  }, 20_000)

  it('POST completes onboarding, writes audit with actor token, and GET reflects completion', async () => {
    const user = await registerUser(suite.app, 'post-happy')
    const res = await postOnboarding(suite.app, user.cookies)

    expect(res.statusCode).toBe(200)
    const body = res.json<{ completed: true; completedAt: string }>()
    expect(body.completed).toBe(true)
    expect(new Date(body.completedAt).toISOString()).toBe(body.completedAt)

    const rows = await listOnboardingRows(user)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.completedAt.toISOString()).toBe(body.completedAt)

    const identityTokens = await withOrg(user.orgId, (tx) =>
      tx
        .select({ id: userIdentityTokens.id })
        .from(userIdentityTokens)
        .where(eq(userIdentityTokens.userId, user.userId))
    )
    expect(identityTokens.length).toBeGreaterThan(0)

    const auditRows = await withOrg(user.orgId, (tx) =>
      tx
        .select({
          eventType: auditLogEntries.eventType,
          resourceType: auditLogEntries.resourceType,
          resourceId: auditLogEntries.resourceId,
          actorTokenId: auditLogEntries.actorTokenId,
        })
        .from(auditLogEntries)
        .where(eq(auditLogEntries.eventType, ONBOARDING_COMPLETED_EVENT))
    )
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0]).toMatchObject({
      eventType: ONBOARDING_COMPLETED_EVENT,
      resourceType: 'user_onboarding',
      resourceId: user.userId,
    })
    expect(auditRows[0]?.actorTokenId).not.toBe(user.userId)
    expect(identityTokens.some((token) => token.id === auditRows[0]?.actorTokenId)).toBe(true)
  }, 20_000)

  it('POST rejects completed: false with 422 and writes nothing', async () => {
    const user = await registerUser(suite.app, 'post-false')
    const res = await postOnboarding(suite.app, user.cookies, false)

    expect(res.statusCode).toBe(422)
    expect(await listOnboardingRows(user)).toHaveLength(0)

    const auditRows = await withOrg(user.orgId, (tx) =>
      tx
        .select({ id: auditLogEntries.id })
        .from(auditLogEntries)
        .where(eq(auditLogEntries.eventType, ONBOARDING_COMPLETED_EVENT))
    )
    expect(auditRows).toHaveLength(0)
  }, 20_000)

  it('POST rejects missing body with 422', async () => {
    const user = await registerUser(suite.app, 'post-missing')
    const res = await suite.app.inject({
      method: 'POST',
      url: ONBOARDING_URL,
      headers: { cookie: cookieHeader(user.cookies) },
      payload: {},
    })
    expect(res.statusCode).toBe(422)
  }, 20_000)

  it('POST returns 409 when onboarding is already completed', async () => {
    const user = await registerUser(suite.app, 'post-duplicate')
    const first = await postOnboarding(suite.app, user.cookies)
    expect(first.statusCode).toBe(200)
    const firstBody = first.json<{ completedAt: string }>()

    const second = await postOnboarding(suite.app, user.cookies)
    expect(second.statusCode).toBe(409)
    expect(second.json()).toMatchObject({ code: 'onboarding_already_completed' })

    const rows = await listOnboardingRows(user)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.completedAt.toISOString()).toBe(firstBody.completedAt)
  }, 20_000)

  it('POST rolls back onboarding insert when audit write fails', async () => {
    const user = await registerUser(suite.app, 'post-audit-fail')
    const auditSpy = vi
      .spyOn(humanAudit, 'writeHumanAuditEntry')
      .mockRejectedValueOnce(new Error(FORCED_AUDIT_FAILURE))

    const res = await postOnboarding(suite.app, user.cookies)
    expectAuditWriteFailed(res)
    expect(await listOnboardingRows(user)).toHaveLength(0)
    auditSpy.mockRestore()
  }, 20_000)

  it('POST returns 401 when unauthenticated', async () => {
    const res = await suite.app.inject({
      method: 'POST',
      url: ONBOARDING_URL,
      payload: { completed: true },
    })
    expect(res.statusCode).toBe(401)
  })
})
