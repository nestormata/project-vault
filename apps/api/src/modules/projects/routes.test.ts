import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { insertTestProject } from '@project-vault/db/test-helpers'
import {
  auditLogEntries,
  orgMemberships,
  projectMemberships,
  projects,
} from '@project-vault/db/schema'
import { EMPTY_PROJECT_DASHBOARD } from '@project-vault/shared'
import {
  assertRoutesFailClosedWhileSealed,
  bootstrapRouteIntegrationTest,
  cookieHeader,
  expectAuditWriteFailed,
  initVaultForTest,
  registerAndLoginViaApi,
} from '../../__tests__/helpers/auth-test-helpers.js'
import {
  createCredentialTestProject,
  createCredentialViaApi,
} from '../credentials/credential-route-test-helpers.js'
import {
  bootProjectRouteTestApp,
  PROJECT_ROUTE_TEST_VAULT_SECRET,
} from './project-route-test-bootstrap.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'

const { createApp, initVault, humanAudit } = await bootstrapRouteIntegrationTest()

type TestApp = Awaited<ReturnType<typeof createApp>>

const TEST_PASSPHRASE = PROJECT_ROUTE_TEST_VAULT_SECRET
const PASSWORD = 'correct-horse-battery-staple'
const PROJECTS_URL = '/api/v1/projects'
const ALPHA_PROJECT_SLUG = 'alpha-project'
const TEAM_PAYMENTS_TAG = 'team-payments'
const TIER_0_TAG = 'tier-0'
const FORCED_AUDIT_FAILURE = 'forced audit failure'

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

async function createProjectDirect(orgId: string, userId: string, slug: string) {
  return insertTestProject(orgId, { userId, slug })
}

async function updateProjectTags(
  app: TestApp,
  cookies: Record<string, string>,
  projectId: string,
  tags: string[]
) {
  return app.inject({
    method: 'PUT',
    url: `${PROJECTS_URL}/${projectId}/tags`,
    headers: { cookie: cookieHeader(cookies) },
    payload: { tags },
  })
}

import {
  createDirectAuthenticatedUser,
  loginExistingUserInOrg,
} from '../../__tests__/helpers/org-role-test-helpers.js'

describe.sequential('project routes', () => {
  let app: TestApp

  beforeAll(async () => {
    app = await bootProjectRouteTestApp(createApp, initVault)
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
    // Story 9.3 D8.2/AC-11: page/limit/hasNext now on the wire, matching every other
    // paginated collection endpoint (credentials, rotation, monitoring, ...).
    expect(empty.json()).toEqual({
      data: { items: [], total: 0, page: 1, limit: 20, hasNext: false },
    })

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
        page: 1,
        limit: 20,
        hasNext: false,
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

  it('GET /api/v1/projects paginates with page/limit query params, defaults, and bounds (AC-11, AC-12)', async () => {
    const user = await registerUser(app, 'list-pagination')
    for (const slug of ['pg-one', 'pg-two', 'pg-three']) {
      await createProject(app, user.cookies, slug)
    }

    const firstPage = await app.inject({
      method: 'GET',
      url: `${PROJECTS_URL}?page=1&limit=2`,
      headers: { cookie: cookieHeader(user.cookies) },
    })
    expect(firstPage.statusCode).toBe(200)
    const firstBody = firstPage.json<{
      data: { items: unknown[]; total: number; page: number; limit: number; hasNext: boolean }
    }>()
    expect(firstBody.data.items).toHaveLength(2)
    expect(firstBody.data).toMatchObject({ total: 3, page: 1, limit: 2, hasNext: true })

    const secondPage = await app.inject({
      method: 'GET',
      url: `${PROJECTS_URL}?page=2&limit=2`,
      headers: { cookie: cookieHeader(user.cookies) },
    })
    const secondBody = secondPage.json<{
      data: { items: unknown[]; total: number; page: number; limit: number; hasNext: boolean }
    }>()
    expect(secondBody.data.items).toHaveLength(1)
    expect(secondBody.data).toMatchObject({ total: 3, page: 2, limit: 2, hasNext: false })

    // AC-12: omitted page/limit still defaults to page=1/limit=20 — backward compatible for any
    // existing caller that never sent pagination params.
    const noParams = await app.inject({
      method: 'GET',
      url: PROJECTS_URL,
      headers: { cookie: cookieHeader(user.cookies) },
    })
    expect(noParams.json<{ data: { page: number; limit: number } }>().data).toMatchObject({
      page: 1,
      limit: 20,
    })

    // AC-12: limit above 100 is rejected (Zod's .max(100)), matching credentials' identical
    // behavior, not silently clamped.
    const overLimit = await app.inject({
      method: 'GET',
      url: `${PROJECTS_URL}?limit=150`,
      headers: { cookie: cookieHeader(user.cookies) },
    })
    expect(overLimit.statusCode).toBe(422)
    expect(overLimit.json()).toMatchObject({ code: 'validation_error' })

    // AC-12 edge case: a page beyond available data is a valid, well-formed empty response.
    const beyondData = await app.inject({
      method: 'GET',
      url: `${PROJECTS_URL}?page=999&limit=20`,
      headers: { cookie: cookieHeader(user.cookies) },
    })
    expect(beyondData.statusCode).toBe(200)
    expect(beyondData.json()).toMatchObject({
      data: { items: [], total: 3, page: 999, limit: 20, hasNext: false },
    })
  }, 20_000)

  it('GET /api/v1/projects returns truthful credential and expiring counts', async () => {
    const user = await createDirectAuthenticatedUser(app, 'list-stats', 'admin')
    const projectId = await createCredentialTestProject(app, user.cookies, 'payments-stats')

    await createCredentialViaApi(app, user.cookies, projectId, {
      name: 'Stripe Secret Key',
      value: 'sk_test',
      expiresAt: '2026-07-15T00:00:00.000Z',
    })
    await createCredentialViaApi(app, user.cookies, projectId, {
      name: 'Legacy API Token',
      value: 'legacy',
      expiresAt: '2026-06-01T00:00:00.000Z',
    })
    await createCredentialViaApi(app, user.cookies, projectId, {
      name: 'Internal Service Key',
      value: 'internal',
    })

    const response = await app.inject({
      method: 'GET',
      url: PROJECTS_URL,
      headers: { cookie: cookieHeader(user.cookies) },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      data: {
        items: [
          expect.objectContaining({
            id: projectId,
            credentialCount: 3,
            expiringCount: 1,
            alertCount: 0,
          }),
        ],
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
    const user = await createDirectAuthenticatedUser(app, 'post-audit-fail', 'admin')
    const auditSpy = vi
      .spyOn(humanAudit, 'writeHumanAuditEntry')
      .mockRejectedValueOnce(new Error(FORCED_AUDIT_FAILURE))

    try {
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
    } finally {
      auditSpy.mockRestore()
    }
  }, 20_000)

  it('rolls back project updates when the audit write fails', async () => {
    const user = await createDirectAuthenticatedUser(app, 'patch-audit-fail', 'admin')
    const project = await createProject(app, user.cookies, 'patch-audit-fail')
    const auditSpy = vi
      .spyOn(humanAudit, 'writeHumanAuditEntry')
      .mockRejectedValueOnce(new Error(FORCED_AUDIT_FAILURE))

    try {
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
    } finally {
      auditSpy.mockRestore()
    }
  }, 20_000)

  it('PUT /api/v1/projects/:projectId/tags replaces tags, de-dupes, clears, and audits', async () => {
    const user = await createDirectAuthenticatedUser(app, 'project-tags')
    const project = await createProjectDirect(user.orgId, user.userId, 'project-tags')
    expect(project.tags).toEqual([])

    const replace = await updateProjectTags(app, user.cookies, project.id, [
      TEAM_PAYMENTS_TAG,
      TEAM_PAYMENTS_TAG,
      TIER_0_TAG,
    ])
    expect(replace.statusCode).toBe(200)
    expect(replace.json()).toEqual({
      data: { id: project.id, tags: [TEAM_PAYMENTS_TAG, TIER_0_TAG] },
    })

    const clear = await updateProjectTags(app, user.cookies, project.id, [])
    expect(clear.statusCode).toBe(200)
    expect(clear.json()).toEqual({ data: { id: project.id, tags: [] } })

    const auditRows = await withOrg(user.orgId, (tx) =>
      tx
        .select({ payload: auditLogEntries.payload, resourceId: auditLogEntries.resourceId })
        .from(auditLogEntries)
        .where(eq(auditLogEntries.eventType, 'project.tags_updated'))
    )
    expect(
      auditRows.some(
        (row) =>
          row.resourceId === project.id &&
          (row.payload as { mode?: string; resultCount?: number }).mode === 'replace'
      )
    ).toBe(true)
  }, 20_000)

  it('PUT project tags normalizes mixed-case input to lowercase (AC-T1/AC-T6)', async () => {
    const user = await createDirectAuthenticatedUser(app, 'project-tags-case')
    const project = await createProjectDirect(user.orgId, user.userId, 'project-tags-case')

    const replace = await updateProjectTags(app, user.cookies, project.id, ['Team-Payments'])
    expect(replace.statusCode).toBe(200)
    expect(replace.json()).toEqual({
      data: { id: project.id, tags: ['team-payments'] },
    })
  }, 20_000)

  it('PUT project tags validates body, hides cross-org projects, denies viewer, and rolls back audit failures', async () => {
    const user = await createDirectAuthenticatedUser(app, 'project-tags-validation')
    const other = await createDirectAuthenticatedUser(app, 'project-tags-other')
    const project = await createProjectDirect(user.orgId, user.userId, 'project-tags-validation')
    const otherProject = await createProjectDirect(other.orgId, other.userId, 'project-tags-other')

    const invalid = await updateProjectTags(app, user.cookies, project.id, [' '])
    expect(invalid.statusCode).toBe(422)

    const crossOrg = await updateProjectTags(app, user.cookies, otherProject.id, ['x'])
    expect(crossOrg.statusCode).toBe(404)

    const auditSpy = vi
      .spyOn(humanAudit, 'writeHumanAuditEntry')
      .mockRejectedValueOnce(new Error(FORCED_AUDIT_FAILURE))
    try {
      const auditFail = await updateProjectTags(app, user.cookies, project.id, ['rolled-back'])
      expectAuditWriteFailed(auditFail)
    } finally {
      auditSpy.mockRestore()
    }

    const afterRollback = await withOrg(user.orgId, (tx) =>
      tx.select({ tags: projects.tags }).from(projects).where(eq(projects.id, project.id))
    )
    expect(afterRollback[0]?.tags).toEqual([])

    const viewerCookies = await loginExistingUserInOrg(app, {
      userId: other.userId,
      orgId: user.orgId,
      role: 'viewer',
    })
    const denied = await updateProjectTags(app, viewerCookies, project.id, ['viewer-denied'])
    expect(denied.statusCode).toBe(403)
  }, 20_000)

  it('project routes fail closed while the vault is sealed', async () => {
    app = await assertRoutesFailClosedWhileSealed(
      app,
      () => createApp({ logger: false, vaultGuardEnabled: true }),
      [
        { method: 'POST', url: PROJECTS_URL, payload: { name: 'Sealed', slug: 'sealed' } },
        { method: 'GET', url: PROJECTS_URL },
        { method: 'GET', url: `/api/v1/projects/${randomUUID()}/dashboard` },
        { method: 'PATCH', url: `/api/v1/projects/${randomUUID()}`, payload: { name: 'Sealed' } },
        {
          method: 'PUT',
          url: `/api/v1/projects/${randomUUID()}/tags`,
          payload: { tags: ['sealed'] },
        },
      ]
    )

    await app.close()
    await initVaultForTest(initVault, TEST_PASSPHRASE)
    app = await createApp({ logger: false, vaultGuardEnabled: true })
  }, 20_000)
})
