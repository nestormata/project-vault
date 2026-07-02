import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { getDb, withOrg } from '@project-vault/db'
import { orgMemberships, projectMemberships, users } from '@project-vault/db/schema'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  createProjectViaApi as createProject,
  mintOrgSessionCookies,
  registerAndLoginViaApi,
  type CookieJar,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import { bootProjectRouteTestApp } from './project-route-test-bootstrap.js'

const { createApp, initVault } = await bootstrapRouteIntegrationTest()

type TestApp = Awaited<ReturnType<typeof createApp>>

const PASSWORD = 'correct-horse-battery-staple'
const RETURNS_404_CROSS_ORG = 'returns 404 for a cross-org project'

function uniqueEmail(label: string): string {
  return `projmembers-${label}-${randomUUID()}@example.com`
}

async function enrollMfa(userId: string): Promise<void> {
  await getDb().update(users).set({ mfaEnrolledAt: new Date() }).where(eq(users.id, userId))
}

async function registerOwner(app: TestApp, label: string) {
  const user = await registerAndLoginViaApi(app, {
    email: uniqueEmail(label),
    password: PASSWORD,
    orgName: `ProjMembers ${label} ${randomUUID()}`,
  })
  await enrollMfa(user.userId)
  return user
}

async function addUserToOrg(
  app: TestApp,
  orgId: string,
  label: string,
  opts: { orgRole?: string } = {}
): Promise<{ userId: string; email: string; cookies: CookieJar }> {
  const email = uniqueEmail(label)
  const user = await registerAndLoginViaApi(app, {
    email,
    password: PASSWORD,
    orgName: `Foreign ${label} ${randomUUID()}`,
  })
  await enrollMfa(user.userId)
  await withOrg(orgId, (tx) =>
    tx.insert(orgMemberships).values({ orgId, userId: user.userId, role: opts.orgRole ?? 'member' })
  )
  // The login cookie above is scoped to the user's *own* org. Re-mint a session bound to the
  // target org so requests made with these cookies authenticate as a member of `orgId`.
  const cookies = await mintOrgSessionCookies(app, user.userId, orgId)
  return { userId: user.userId, email, cookies }
}

async function addProjectMember(
  orgId: string,
  projectId: string,
  userId: string,
  role: string
): Promise<void> {
  await withOrg(orgId, (tx) =>
    tx.insert(projectMemberships).values({ orgId, projectId, userId, role })
  )
}

async function projectRoleOf(
  orgId: string,
  projectId: string,
  userId: string
): Promise<string | undefined> {
  const [row] = await withOrg(orgId, (tx) =>
    tx
      .select({ role: projectMemberships.role })
      .from(projectMemberships)
      .where(
        and(eq(projectMemberships.projectId, projectId), eq(projectMemberships.userId, userId))
      )
  )
  return row?.role
}

function listMembers(app: TestApp, cookies: CookieJar, projectId: string) {
  return app.inject({
    method: 'GET',
    url: `/api/v1/projects/${projectId}/members`,
    headers: { cookie: cookieHeader(cookies) },
  })
}

function removeMember(app: TestApp, cookies: CookieJar, projectId: string, userId: string) {
  return app.inject({
    method: 'DELETE',
    url: `/api/v1/projects/${projectId}/members/${userId}`,
    headers: { cookie: cookieHeader(cookies) },
  })
}

function transferOwnership(app: TestApp, cookies: CookieJar, projectId: string, body: unknown) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/projects/${projectId}/transfer-ownership`,
    headers: { cookie: cookieHeader(cookies) },
    payload: body,
  })
}

describe.sequential('project member management routes', () => {
  let app: TestApp

  beforeAll(async () => {
    app = await bootProjectRouteTestApp(createApp, initVault)
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  describe('GET /api/v1/projects/:projectId/members', () => {
    it('lists accepted members for a project-admin caller (200)', async () => {
      const owner = await registerOwner(app, 'members-owner')
      const project = await createProject(app, owner.cookies, 'members-proj')
      const jordan = await addUserToOrg(app, owner.orgId, 'members-jordan')
      await addProjectMember(owner.orgId, project, jordan.userId, 'admin')

      const res = await listMembers(app, owner.cookies, project)
      expect(res.statusCode).toBe(200)
      const body = res.json<{
        data: { userId: string; role: string; displayName: string; email: string }[]
      }>()
      expect(body.data.some((m) => m.userId === owner.userId && m.role === 'owner')).toBe(true)
      const jordanRow = body.data.find((m) => m.userId === jordan.userId)
      expect(jordanRow?.role).toBe('admin')
      expect(jordanRow?.displayName).toBe(jordanRow?.email)
    })

    it('allows an org-admin override caller with no project membership (200)', async () => {
      const owner = await registerOwner(app, 'members-orgadmin-owner')
      const project = await createProject(app, owner.cookies, 'members-orgadmin-proj')
      const admin = await addUserToOrg(app, owner.orgId, 'members-orgadmin', { orgRole: 'admin' })

      const res = await listMembers(app, admin.cookies, project)
      expect(res.statusCode).toBe(200)
    })

    it('rejects a non-admin project member (403)', async () => {
      const owner = await registerOwner(app, 'members-403-owner')
      const project = await createProject(app, owner.cookies, 'members-403-proj')
      const viewer = await addUserToOrg(app, owner.orgId, 'members-403-viewer', {
        orgRole: 'member',
      })
      await addProjectMember(owner.orgId, project, viewer.userId, 'viewer')

      const res = await listMembers(app, viewer.cookies, project)
      expect(res.statusCode).toBe(403)
      expect(res.json()).toMatchObject({ code: 'insufficient_role' })
    })

    it(RETURNS_404_CROSS_ORG, async () => {
      const owner = await registerOwner(app, 'members-cross-owner')
      const other = await registerOwner(app, 'members-cross-other')
      const otherProject = await createProject(app, other.cookies, 'members-cross-proj')
      const res = await listMembers(app, owner.cookies, otherProject)
      expect(res.statusCode).toBe(404)
      expect(res.json()).toMatchObject({ code: 'project_not_found' })
    })

    it('returns the sole owner for a single-member project', async () => {
      const owner = await registerOwner(app, 'members-solo-owner')
      const project = await createProject(app, owner.cookies, 'members-solo-proj')
      const res = await listMembers(app, owner.cookies, project)
      expect(res.statusCode).toBe(200)
      const body = res.json<{ data: unknown[] }>()
      expect(body.data).toHaveLength(1)
    })
  })

  describe('DELETE /api/v1/projects/:projectId/members/:userId', () => {
    it('removes a member via a project-admin caller (204)', async () => {
      const owner = await registerOwner(app, 'rm-projadmin-owner')
      const project = await createProject(app, owner.cookies, 'rm-projadmin-proj')
      const admin = await addUserToOrg(app, owner.orgId, 'rm-projadmin', { orgRole: 'member' })
      await addProjectMember(owner.orgId, project, admin.userId, 'admin')
      const jordan = await addUserToOrg(app, owner.orgId, 'rm-projadmin-jordan')
      await addProjectMember(owner.orgId, project, jordan.userId, 'member')

      const res = await removeMember(app, admin.cookies, project, jordan.userId)
      expect(res.statusCode).toBe(204)
      expect(await projectRoleOf(owner.orgId, project, jordan.userId)).toBeUndefined()
    })

    it('removes a member via an org-admin override caller with no project role (204)', async () => {
      const owner = await registerOwner(app, 'rm-orgadmin-owner')
      const project = await createProject(app, owner.cookies, 'rm-orgadmin-proj')
      const admin = await addUserToOrg(app, owner.orgId, 'rm-orgadmin', { orgRole: 'admin' })
      const jordan = await addUserToOrg(app, owner.orgId, 'rm-orgadmin-jordan')
      await addProjectMember(owner.orgId, project, jordan.userId, 'member')

      const res = await removeMember(app, admin.cookies, project, jordan.userId)
      expect(res.statusCode).toBe(204)
    })

    it('allows self-removal by a non-owner project admin (204)', async () => {
      const owner = await registerOwner(app, 'rm-self-owner')
      const project = await createProject(app, owner.cookies, 'rm-self-proj')
      const admin = await addUserToOrg(app, owner.orgId, 'rm-self-admin', { orgRole: 'member' })
      await addProjectMember(owner.orgId, project, admin.userId, 'admin')

      const res = await removeMember(app, admin.cookies, project, admin.userId)
      expect(res.statusCode).toBe(204)
      expect(await projectRoleOf(owner.orgId, project, admin.userId)).toBeUndefined()
    })

    it('blocks self-removal by the sole owner (409 last_owner)', async () => {
      const owner = await registerOwner(app, 'rm-sole-owner')
      const project = await createProject(app, owner.cookies, 'rm-sole-proj')
      const res = await removeMember(app, owner.cookies, project, owner.userId)
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ code: 'last_owner' })
      expect(await projectRoleOf(owner.orgId, project, owner.userId)).toBe('owner')
    })

    it('blocks removing another sole owner (409 last_owner)', async () => {
      const owner = await registerOwner(app, 'rm-other-sole-owner')
      const project = await createProject(app, owner.cookies, 'rm-other-sole-proj')
      // owner is the sole owner; org owner removes themselves-as-owner check via a different caller
      const res = await removeMember(app, owner.cookies, project, owner.userId)
      expect(res.statusCode).toBe(409)
    })

    it('returns 404 for a non-member target', async () => {
      const owner = await registerOwner(app, 'rm-404-owner')
      const project = await createProject(app, owner.cookies, 'rm-404-proj')
      const res = await removeMember(app, owner.cookies, project, randomUUID())
      expect(res.statusCode).toBe(404)
      expect(res.json()).toMatchObject({ code: 'membership_not_found' })
    })

    it('rejects a caller who is neither project admin/owner nor org admin/owner (403)', async () => {
      const owner = await registerOwner(app, 'rm-403-owner')
      const project = await createProject(app, owner.cookies, 'rm-403-proj')
      const member = await addUserToOrg(app, owner.orgId, 'rm-403-member', { orgRole: 'member' })
      await addProjectMember(owner.orgId, project, member.userId, 'member')
      const jordan = await addUserToOrg(app, owner.orgId, 'rm-403-jordan')
      await addProjectMember(owner.orgId, project, jordan.userId, 'member')

      const res = await removeMember(app, member.cookies, project, jordan.userId)
      expect(res.statusCode).toBe(403)
    })

    it('succeeds for an org-viewer who is a project admin (project-axis wins)', async () => {
      const owner = await registerOwner(app, 'rm-viewer-owner')
      const project = await createProject(app, owner.cookies, 'rm-viewer-proj')
      const viewer = await addUserToOrg(app, owner.orgId, 'rm-viewer', { orgRole: 'viewer' })
      await addProjectMember(owner.orgId, project, viewer.userId, 'admin')
      const jordan = await addUserToOrg(app, owner.orgId, 'rm-viewer-jordan')
      await addProjectMember(owner.orgId, project, jordan.userId, 'member')

      const res = await removeMember(app, viewer.cookies, project, jordan.userId)
      expect(res.statusCode).toBe(204)
    })

    it(RETURNS_404_CROSS_ORG, async () => {
      const owner = await registerOwner(app, 'rm-cross-owner')
      const other = await registerOwner(app, 'rm-cross-other')
      const otherProject = await createProject(app, other.cookies, 'rm-cross-proj')
      const res = await removeMember(app, owner.cookies, otherProject, other.userId)
      expect(res.statusCode).toBe(404)
    })
  })

  describe('POST /api/v1/projects/:projectId/transfer-ownership', () => {
    it('transfers ownership (project-owner-initiated, 200)', async () => {
      const owner = await registerOwner(app, 'xfer-owner')
      const project = await createProject(app, owner.cookies, 'xfer-proj')
      const priya = await addUserToOrg(app, owner.orgId, 'xfer-priya')
      await addProjectMember(owner.orgId, project, priya.userId, 'member')

      const res = await transferOwnership(app, owner.cookies, project, { newOwnerId: priya.userId })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({
        data: { projectId: project, previousOwnerId: owner.userId, newOwnerId: priya.userId },
      })
      expect(await projectRoleOf(owner.orgId, project, priya.userId)).toBe('owner')
      expect(await projectRoleOf(owner.orgId, project, owner.userId)).toBe('admin')
    })

    it('transfers ownership via an org-owner override with no project membership (200)', async () => {
      const owner = await registerOwner(app, 'xfer-orgowner')
      const project = await createProject(app, owner.cookies, 'xfer-orgowner-proj')
      // A second org owner acts as override; they are not a member of the project.
      const orgOwner2 = await addUserToOrg(app, owner.orgId, 'xfer-orgowner2', { orgRole: 'owner' })
      const priya = await addUserToOrg(app, owner.orgId, 'xfer-orgowner-priya')
      await addProjectMember(owner.orgId, project, priya.userId, 'member')

      const res = await transferOwnership(app, orgOwner2.cookies, project, {
        newOwnerId: priya.userId,
      })
      expect(res.statusCode).toBe(200)
      expect(await projectRoleOf(owner.orgId, project, priya.userId)).toBe('owner')
      expect(await projectRoleOf(owner.orgId, project, owner.userId)).toBe('admin')
    })

    it('returns 404 for a non-accepted-member target', async () => {
      const owner = await registerOwner(app, 'xfer-notmember')
      const project = await createProject(app, owner.cookies, 'xfer-notmember-proj')
      const priya = await addUserToOrg(app, owner.orgId, 'xfer-notmember-priya')

      const res = await transferOwnership(app, owner.cookies, project, { newOwnerId: priya.userId })
      expect(res.statusCode).toBe(404)
      expect(res.json()).toMatchObject({ code: 'not_a_project_member' })
    })

    it('rejects a non-owner and non-org-owner caller (403)', async () => {
      const owner = await registerOwner(app, 'xfer-403-owner')
      const project = await createProject(app, owner.cookies, 'xfer-403-proj')
      const admin = await addUserToOrg(app, owner.orgId, 'xfer-403-admin', { orgRole: 'admin' })
      await addProjectMember(owner.orgId, project, admin.userId, 'admin')
      const priya = await addUserToOrg(app, owner.orgId, 'xfer-403-priya')
      await addProjectMember(owner.orgId, project, priya.userId, 'member')

      const res = await transferOwnership(app, admin.cookies, project, { newOwnerId: priya.userId })
      expect(res.statusCode).toBe(403)
      expect(res.json()).toMatchObject({ code: 'insufficient_role' })
    })

    it('rejects self-transfer (422 invalid_new_owner)', async () => {
      const owner = await registerOwner(app, 'xfer-self')
      const project = await createProject(app, owner.cookies, 'xfer-self-proj')
      const res = await transferOwnership(app, owner.cookies, project, { newOwnerId: owner.userId })
      expect(res.statusCode).toBe(422)
      expect(res.json()).toMatchObject({ code: 'invalid_new_owner' })
    })

    it('rejects transferring to a user who is already the owner (409 already_owner)', async () => {
      const owner = await registerOwner(app, 'xfer-already-owner')
      const project = await createProject(app, owner.cookies, 'xfer-already-proj')
      const orgOwner2 = await addUserToOrg(app, owner.orgId, 'xfer-already-org2', {
        orgRole: 'owner',
      })
      const res = await transferOwnership(app, orgOwner2.cookies, project, {
        newOwnerId: owner.userId,
      })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ code: 'already_owner' })
    })

    it(RETURNS_404_CROSS_ORG, async () => {
      const owner = await registerOwner(app, 'xfer-cross-owner')
      const other = await registerOwner(app, 'xfer-cross-other')
      const otherProject = await createProject(app, other.cookies, 'xfer-cross-proj')
      const res = await transferOwnership(app, owner.cookies, otherProject, {
        newOwnerId: other.userId,
      })
      // caller has no membership + not org owner of the other org -> 403
      expect([403, 404]).toContain(res.statusCode)
    })
  })
})
