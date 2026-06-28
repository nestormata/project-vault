import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { orgMemberships, projectMemberships, projects } from '@project-vault/db/schema'
import { EMPTY_PROJECT_DASHBOARD } from '@project-vault/shared'
import {
  configureAuthIntegrationEnv,
  cookieHeader,
  initVaultForTest,
  registerAndLoginViaApi,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'

configureAuthIntegrationEnv()

const { createApp } = await import('../../app.js')
const { initVault } = await import('../vault/key-service.js')
const humanAudit = await import('../audit/human-entry.js')
const { createLoginSessionInTx } = await import('../auth/service.js')

type TestApp = Awaited<ReturnType<typeof createApp>>

const TEST_PASSPHRASE = 'project-routes-passphrase'
const PASSWORD = 'correct-horse-battery-staple'
const PROJECTS_URL = '/api/v1/projects'
const ALPHA_PROJECT_SLUG = 'alpha-project'

function expectAuditWriteFailed(response: Awaited<ReturnType<TestApp['inject']>>) {
  expect(response.statusCode).toBe(503)
  expect(response.json()).toMatchObject({ code: 'audit_write_failed' })
}

function uniqueEmail(label: string): string {
  return `projects-${label}-${randomUUID()}@example.com`
}

async function registerUser(app: TestApp, label: string) {
  return registerAndLoginViaApi(app, {
    email: uniqueEmail(label),
    password: PASSWORD,
    orgName: `Projects ${label} ${randomUUID()}`,
  })
}

async function createProject(app: TestApp, cookies: Record<string, string>, slug: string) {
  const response = await app.inject({
    method: 'POST',
    url: PROJECTS_URL,
    headers: { cookie: cookieHeader(cookies) },
    payload: { name: `Project ${slug}`, slug },
  })
  expect(response.statusCode).toBe(201)
  return response.json<{
    data: {
      id: string
      name: string
      slug: string
      description: string | null
      role: string
      createdAt: string
      updatedAt: string
    }
  }>().data
}

async function loginExistingUserInOrg(
  app: TestApp,
  input: { userId: string; orgId: string; role: 'viewer' | 'member' | 'admin' }
) {
  const result = await withOrg(input.orgId, async (tx) => {
    await tx.insert(orgMemberships).values({
      orgId: input.orgId,
      userId: input.userId,
      role: input.role,
      status: 'active',
    })
    return createLoginSessionInTx(tx, { id: input.userId, identityTokenId: null }, input.orgId, {})
  })
  const jwt = await (
    app as TestApp & {
      jwt: {
        sign: (
          payload: Record<string, unknown>,
          options: { jti: string; expiresIn: number }
        ) => Promise<string>
      }
    }
  ).jwt.sign(
    {
      sub: result.tokens.accessClaims.sub,
      orgId: result.tokens.accessClaims.orgId,
      sessionVersion: result.tokens.accessClaims.sessionVersion,
    },
    { jti: result.tokens.accessClaims.jti, expiresIn: result.tokens.accessMaxAgeSec }
  )
  return { 'access-token': jwt }
}

describe.sequential('project routes', () => {
  let app: TestApp

  beforeAll(async () => {
    await resetVaultForTest()
    await initVaultForTest(initVault, TEST_PASSPHRASE)
    app = await createApp({ logger: false, vaultGuardEnabled: true })
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  it('POST /api/v1/projects creates a project and owner membership', async () => {
    const user = await registerUser(app, 'create')
    const res = await app.inject({
      method: 'POST',
      url: PROJECTS_URL,
      headers: { cookie: cookieHeader(user.cookies) },
      payload: {
        name: 'Payments API',
        slug: 'payments-api',
        description: 'All credentials for payments.',
      },
    })

    expect(res.statusCode).toBe(201)
    const body = res.json<{
      data: { id: string; orgId: string; role: string; createdAt: string }
    }>()
    expect(body.data).toMatchObject({
      orgId: user.orgId,
      role: 'owner',
      slug: 'payments-api',
      description: 'All credentials for payments.',
    })
    expect(new Date(body.data.createdAt).toISOString()).toBe(body.data.createdAt)

    const membership = await withOrg(user.orgId, (tx) =>
      tx
        .select({ role: projectMemberships.role })
        .from(projectMemberships)
        .where(
          and(
            eq(projectMemberships.projectId, body.data.id),
            eq(projectMemberships.userId, user.userId)
          )
        )
        .limit(1)
    )
    expect(membership[0]?.role).toBe('owner')
  }, 20_000)

  it('POST defaults omitted description to null and rejects duplicate or invalid slugs', async () => {
    const user = await registerUser(app, 'slug')
    const created = await createProject(app, user.cookies, 'slug-project')
    expect(created.description).toBeNull()

    const duplicate = await app.inject({
      method: 'POST',
      url: PROJECTS_URL,
      headers: { cookie: cookieHeader(user.cookies) },
      payload: { name: 'Duplicate', slug: 'slug-project' },
    })
    expect(duplicate.statusCode).toBe(409)
    expect(duplicate.json()).toMatchObject({ code: 'slug_taken' })

    for (const slug of ['Payments-API', 'payments api', '-payments']) {
      const invalid = await app.inject({
        method: 'POST',
        url: PROJECTS_URL,
        headers: { cookie: cookieHeader(user.cookies) },
        payload: { name: 'Invalid', slug },
      })
      expect(invalid.statusCode).toBe(422)
      expect(invalid.json()).toMatchObject({ code: 'validation_error' })
    }
  }, 20_000)

  it('POST rejects missing auth, missing name, and body orgId poisoning', async () => {
    const user = await registerUser(app, 'validation')
    const unauthenticated = await app.inject({
      method: 'POST',
      url: PROJECTS_URL,
      payload: { name: 'Unauth', slug: 'unauth' },
    })
    expect(unauthenticated.statusCode).toBe(401)

    const missingName = await app.inject({
      method: 'POST',
      url: PROJECTS_URL,
      headers: { cookie: cookieHeader(user.cookies) },
      payload: { slug: 'missing-name' },
    })
    expect(missingName.statusCode).toBe(422)

    const poisoned = await app.inject({
      method: 'POST',
      url: PROJECTS_URL,
      headers: { cookie: cookieHeader(user.cookies) },
      payload: { name: 'Poisoned', slug: 'poisoned', orgId: randomUUID() },
    })
    expect(poisoned.statusCode).toBe(422)
  }, 20_000)

  it('GET /api/v1/projects returns empty and populated org-scoped lists', async () => {
    const userA = await registerUser(app, 'list-a')
    const userB = await registerUser(app, 'list-b')

    const empty = await app.inject({
      method: 'GET',
      url: PROJECTS_URL,
      headers: { cookie: cookieHeader(userA.cookies) },
    })
    expect(empty.statusCode).toBe(200)
    expect(empty.json()).toEqual({ data: { items: [], total: 0 } })

    await createProject(app, userA.cookies, ALPHA_PROJECT_SLUG)
    await createProject(app, userB.cookies, 'other-org-project')

    const populated = await app.inject({
      method: 'GET',
      url: PROJECTS_URL,
      headers: { cookie: cookieHeader(userA.cookies) },
    })
    expect(populated.statusCode).toBe(200)
    expect(populated.json()).toMatchObject({
      data: {
        total: 1,
        items: [
          {
            slug: ALPHA_PROJECT_SLUG,
            role: 'owner',
            credentialCount: 0,
            expiringCount: 0,
            alertCount: 0,
          },
        ],
      },
    })

    const sameOrgViewerCookies = await loginExistingUserInOrg(app, {
      userId: userB.userId,
      orgId: userA.orgId,
      role: 'viewer',
    })
    const sameOrg = await app.inject({
      method: 'GET',
      url: PROJECTS_URL,
      headers: { cookie: cookieHeader(sameOrgViewerCookies) },
    })
    expect(sameOrg.statusCode).toBe(200)
    expect(sameOrg.json()).toMatchObject({
      data: {
        total: 1,
        items: [expect.objectContaining({ slug: ALPHA_PROJECT_SLUG, role: 'viewer' })],
      },
    })
  }, 20_000)

  it('GET dashboard returns empty state and hides cross-org projects as 404', async () => {
    const userA = await registerUser(app, 'dashboard-a')
    const userB = await registerUser(app, 'dashboard-b')
    const projectA = await createProject(app, userA.cookies, 'dashboard-project')

    const dashboard = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectA.id}/dashboard`,
      headers: { cookie: cookieHeader(userA.cookies) },
    })
    expect(dashboard.statusCode).toBe(200)
    expect(dashboard.json()).toMatchObject({ data: EMPTY_PROJECT_DASHBOARD })

    const crossOrg = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectA.id}/dashboard`,
      headers: { cookie: cookieHeader(userB.cookies) },
    })
    expect(crossOrg.statusCode).toBe(404)
    expect(crossOrg.json()).toMatchObject({ code: 'project_not_found' })

    const malformed = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/not-a-uuid/dashboard',
      headers: { cookie: cookieHeader(userA.cookies) },
    })
    expect(malformed.statusCode).toBe(422)

    const missing = await app.inject({
      method: 'GET',
      url: `${PROJECTS_URL}/${randomUUID()}/dashboard`,
      headers: { cookie: cookieHeader(userA.cookies) },
    })
    expect(missing.statusCode).toBe(404)

    const unauthenticated = await app.inject({
      method: 'GET',
      url: `${PROJECTS_URL}/${projectA.id}/dashboard`,
    })
    expect(unauthenticated.statusCode).toBe(401)
  }, 20_000)

  it('PATCH updates metadata, preserves slug, clears description, and denies viewer role', async () => {
    const user = await registerUser(app, 'patch')
    const project = await createProject(app, user.cookies, 'patch-project')

    const update = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${project.id}`,
      headers: { cookie: cookieHeader(user.cookies) },
      payload: { name: 'Updated Project', description: 'Updated', slug: 'ignored-slug' },
    })
    expect(update.statusCode).toBe(200)
    expect(update.json()).toMatchObject({
      data: { name: 'Updated Project', description: 'Updated', slug: 'patch-project' },
    })
    expect(
      new Date(update.json<{ data: { updatedAt: string } }>().data.updatedAt).getTime()
    ).toBeGreaterThanOrEqual(new Date(project.updatedAt).getTime())

    const clear = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${project.id}`,
      headers: { cookie: cookieHeader(user.cookies) },
      payload: { description: null },
    })
    expect(clear.statusCode).toBe(200)
    expect(clear.json()).toMatchObject({ data: { description: null } })

    const empty = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${project.id}`,
      headers: { cookie: cookieHeader(user.cookies) },
      payload: {},
    })
    expect(empty.statusCode).toBe(422)

    const missing = await app.inject({
      method: 'PATCH',
      url: `${PROJECTS_URL}/${randomUUID()}`,
      headers: { cookie: cookieHeader(user.cookies) },
      payload: { name: 'Missing' },
    })
    expect(missing.statusCode).toBe(404)

    const unauthenticated = await app.inject({
      method: 'PATCH',
      url: `${PROJECTS_URL}/${project.id}`,
      payload: { name: 'Unauthenticated' },
    })
    expect(unauthenticated.statusCode).toBe(401)

    await withOrg(user.orgId, (tx) =>
      tx
        .update(orgMemberships)
        .set({ role: 'viewer' })
        .where(eq(orgMemberships.userId, user.userId))
    )
    const denied = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${project.id}`,
      headers: { cookie: cookieHeader(user.cookies) },
      payload: { name: 'Denied' },
    })
    expect(denied.statusCode).toBe(403)
  }, 20_000)

  it('rolls back project creation when the audit write fails', async () => {
    const user = await registerUser(app, 'post-audit-fail')
    const auditSpy = vi
      .spyOn(humanAudit, 'writeHumanAuditEntry')
      .mockRejectedValueOnce(new Error('forced audit failure'))

    const res = await app.inject({
      method: 'POST',
      url: PROJECTS_URL,
      headers: { cookie: cookieHeader(user.cookies) },
      payload: { name: 'Audit Fail', slug: 'audit-fail' },
    })

    expectAuditWriteFailed(res)

    const rows = await withOrg(user.orgId, (tx) =>
      tx.select({ id: projects.id }).from(projects).where(eq(projects.slug, 'audit-fail'))
    )
    const memberships = await withOrg(user.orgId, (tx) =>
      tx
        .select({ projectId: projectMemberships.projectId })
        .from(projectMemberships)
        .where(eq(projectMemberships.userId, user.userId))
    )
    expect(rows).toHaveLength(0)
    expect(memberships).toHaveLength(0)
    auditSpy.mockRestore()
  }, 20_000)

  it('rolls back project updates when the audit write fails', async () => {
    const user = await registerUser(app, 'patch-audit-fail')
    const project = await createProject(app, user.cookies, 'patch-audit-fail')
    const auditSpy = vi
      .spyOn(humanAudit, 'writeHumanAuditEntry')
      .mockRejectedValueOnce(new Error('forced audit failure'))

    const res = await app.inject({
      method: 'PATCH',
      url: `${PROJECTS_URL}/${project.id}`,
      headers: { cookie: cookieHeader(user.cookies) },
      payload: { name: 'Should Roll Back' },
    })

    expectAuditWriteFailed(res)

    const rows = await withOrg(user.orgId, (tx) =>
      tx.select({ name: projects.name }).from(projects).where(eq(projects.id, project.id))
    )
    expect(rows[0]?.name).toBe(project.name)
    auditSpy.mockRestore()
  }, 20_000)

  it('project routes fail closed while the vault is sealed', async () => {
    await app.close()
    await resetVaultForTest()
    app = await createApp({ logger: false, vaultGuardEnabled: true })

    for (const request of [
      { method: 'POST', url: PROJECTS_URL, payload: { name: 'Sealed', slug: 'sealed' } },
      { method: 'GET', url: PROJECTS_URL },
      { method: 'GET', url: `/api/v1/projects/${randomUUID()}/dashboard` },
      { method: 'PATCH', url: `/api/v1/projects/${randomUUID()}`, payload: { name: 'Sealed' } },
    ] as const) {
      const res = await app.inject(request)
      expect(res.statusCode).toBe(503)
      expect(res.json()).toMatchObject({ status: 'sealed' })
    }

    await app.close()
    await initVaultForTest(initVault, TEST_PASSPHRASE)
    app = await createApp({ logger: false, vaultGuardEnabled: true })
  }, 20_000)
})
