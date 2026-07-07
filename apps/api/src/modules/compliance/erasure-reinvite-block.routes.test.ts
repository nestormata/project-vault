import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb, withOrg } from '@project-vault/db'
import { orgMemberships, users } from '@project-vault/db/schema'
import { createTestUser } from '@project-vault/db/test-helpers'
import type { CookieJar } from '../../__tests__/helpers/auth-test-helpers.js'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  createProjectViaApi,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { bootProjectRouteTestApp } from '../projects/project-route-test-bootstrap.js'
import { createMembershipTestHelpers } from '../../__tests__/helpers/membership-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'

const { createApp, initVault } = await bootstrapRouteIntegrationTest()

type TestApp = Awaited<ReturnType<typeof createApp>>

const { registerOwner } = createMembershipTestHelpers({
  emailPrefix: 'erasure-reinvite',
  orgNamePrefix: 'ErasureReinvite',
})

async function createSingleOrgMember(orgId: string, label: string): Promise<string> {
  const userId = await createTestUser(label)
  await withOrg(orgId, (tx) => tx.insert(orgMemberships).values({ orgId, userId, role: 'member' }))
  return userId
}

async function emailOf(userId: string): Promise<string> {
  const [row] = await getDb().select({ email: users.email }).from(users).where(eq(users.id, userId))
  if (!row) throw new Error(`no user row for ${userId}`)
  return row.email
}

async function createAndExecuteErasure(
  app: TestApp,
  owner: { cookies: CookieJar },
  userId: string
): Promise<void> {
  const created = await app.inject({
    method: 'POST',
    url: `/api/v1/org/users/${userId}/erasure-request`,
    headers: { cookie: cookieHeader(owner.cookies) },
    payload: { reason: 'GDPR Article 17 request', requestedBy: 'privacy@example.com' },
  })
  expect(created.statusCode).toBe(201)
  const requestId = created.json<{ data: { requestId: string } }>().data.requestId
  const executed = await app.inject({
    method: 'POST',
    url: `/api/v1/org/users/${userId}/erasure-request/${requestId}/execute`,
    headers: { cookie: cookieHeader(owner.cookies) },
    payload: { confirm: true },
  })
  expect(executed.statusCode).toBe(200)
}

function inviteToProject(app: TestApp, cookies: CookieJar, projectId: string, email: string) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/projects/${projectId}/invitations`,
    headers: { cookie: cookieHeader(cookies) },
    payload: { email, role: 'member' },
  })
}

function registerViaApi(app: TestApp, email: string) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {
      email,
      password: 'correct-horse-battery-staple',
      orgName: `Reinvite Register ${randomUUID()}`,
    },
  })
}

describe.sequential('erasure re-invite block (Story 8.4 D6, AC-17/AC-17B/AC-18)', () => {
  let app: TestApp

  beforeAll(async () => {
    app = await bootProjectRouteTestApp(createApp, initVault)
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  it('blocks re-inviting an erased user with 410 user_erased (AC-17)', async () => {
    const owner = await registerOwner(app, 'ac17-owner')
    const projectId = await createProjectViaApi(app, owner.cookies, 'ac17-project')
    const samId = await createSingleOrgMember(owner.orgId, 'ac17-sam')
    const samEmail = await emailOf(samId)
    await createAndExecuteErasure(app, owner, samId)

    const res = await inviteToProject(app, owner.cookies, projectId, samEmail)

    expect(res.statusCode).toBe(410)
    expect(res.json()).toMatchObject({ code: 'user_erased' })
  })

  it('still blocks when the email casing/whitespace differs (AC-17 edge case)', async () => {
    const owner = await registerOwner(app, 'ac17b-owner')
    const projectId = await createProjectViaApi(app, owner.cookies, 'ac17b-project')
    const samId = await createSingleOrgMember(owner.orgId, 'ac17b-sam')
    const samEmail = await emailOf(samId)
    await createAndExecuteErasure(app, owner, samId)

    const differentCasing = samEmail.toUpperCase()
    const res = await inviteToProject(app, owner.cookies, projectId, differentCasing)

    expect(res.statusCode).toBe(410)
    expect(res.json()).toMatchObject({ code: 'user_erased' })
  })

  it('blocks re-invite even while the erasure request is still pending, not yet executed (AC-17 edge case)', async () => {
    const owner = await registerOwner(app, 'ac17c-owner')
    const projectId = await createProjectViaApi(app, owner.cookies, 'ac17c-project')
    const samId = await createSingleOrgMember(owner.orgId, 'ac17c-sam')
    const samEmail = await emailOf(samId)
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/org/users/${samId}/erasure-request`,
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { reason: 'GDPR Article 17 request', requestedBy: 'privacy@example.com' },
    })
    expect(created.statusCode).toBe(201)

    const res = await inviteToProject(app, owner.cookies, projectId, samEmail)

    expect(res.statusCode).toBe(410)
    expect(res.json()).toMatchObject({ code: 'user_erased' })
  })

  it('does not block inviting an unrelated, never-erased user (AC-18)', async () => {
    const owner = await registerOwner(app, 'ac18-owner')
    const projectId = await createProjectViaApi(app, owner.cookies, 'ac18-project')
    const samId = await createSingleOrgMember(owner.orgId, 'ac18-sam')
    await createAndExecuteErasure(app, owner, samId)

    const res = await inviteToProject(
      app,
      owner.cookies,
      projectId,
      `alex-unrelated-${randomUUID()}@example.com`
    )

    expect(res.statusCode).toBe(201)
  })

  it('blocks self-registration under the erased identity original email with 410 user_erased (AC-17B)', async () => {
    const owner = await registerOwner(app, 'ac17d-owner')
    const samId = await createSingleOrgMember(owner.orgId, 'ac17d-sam')
    const samEmail = await emailOf(samId)
    await createAndExecuteErasure(app, owner, samId)

    const res = await registerViaApi(app, samEmail)

    expect(res.statusCode).toBe(410)
    expect(res.json()).toMatchObject({ code: 'user_erased' })
  })

  it('allows a different, never-erased user to register normally (AC-17B edge case)', async () => {
    const res = await registerViaApi(app, `never-erased-${randomUUID()}@example.com`)

    expect(res.statusCode).toBe(201)
  })
})
