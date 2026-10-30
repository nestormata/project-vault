import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withOrg } from '@project-vault/db'
import { orgMemberships, projects } from '@project-vault/db/schema'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  createProjectViaApi as createProject,
  registerAndLoginViaApi,
  type CookieJar,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { archiveAuditRowsFor } from '../../__tests__/helpers/archive-audit-test-helpers.js'
import { createMembershipTestHelpers } from '../../__tests__/helpers/membership-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import { forEachSequential } from '../../lib/for-each-sequential.js'
import { addExistingOrgUserToProject } from './member-management.js'
import { bootProjectRouteTestApp } from './project-route-test-bootstrap.js'

const { createApp, initVault } = await bootstrapRouteIntegrationTest()

type TestApp = Awaited<ReturnType<typeof createApp>>
type MemberRow = { userId: string; email: string; displayName: string; role: string }

const ADDED = 'project.member_added'
// Body validation answers 422 `validation_error` across the repo (the story text says 400).
const BODY_REJECTION_STATUS = 422

const { registerOwner, addUserToOrg, addProjectMember, projectRoleOf } =
  createMembershipTestHelpers({ emailPrefix: 'addmember', orgNamePrefix: 'AddMember' })

function addMember(app: TestApp, cookies: CookieJar, projectId: string, body: unknown) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/projects/${projectId}/members`,
    headers: { cookie: cookieHeader(cookies) },
    payload: body as Record<string, unknown>,
  })
}

async function addedAuditCount(orgId: string, userId: string): Promise<number> {
  return (await archiveAuditRowsFor(orgId, ADDED, userId)).length
}

const ORIGINAL_BYPASS = process.env['RATE_LIMIT_TEST_BYPASS']

describe('POST /api/v1/projects/:projectId/members (Story 72-14)', () => {
  let app: TestApp

  beforeAll(async () => {
    app = await bootProjectRouteTestApp(createApp, initVault)
  })

  afterAll(async () => {
    if (ORIGINAL_BYPASS === undefined) delete process.env['RATE_LIMIT_TEST_BYPASS']
    else process.env['RATE_LIMIT_TEST_BYPASS'] = ORIGINAL_BYPASS
    await app.close()
    await resetVaultForTest()
  })

  it('adds an existing org user: 201, the list-route row shape, exactly one audit event', async () => {
    const owner = await registerOwner(app, 'happy-owner')
    const project = await createProject(app, owner.cookies, 'happy-proj')
    const jordan = await addUserToOrg(app, owner.orgId, 'happy-jordan')

    const res = await addMember(app, owner.cookies, project, {
      userId: jordan.userId,
      role: 'member',
    })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toStrictEqual({
      data: {
        userId: jordan.userId,
        email: jordan.email,
        displayName: jordan.email,
        role: 'member',
      },
    })
    expect(await projectRoleOf(owner.orgId, project, jordan.userId)).toBe('member')

    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project}/members`,
      headers: { cookie: cookieHeader(owner.cookies) },
    })
    expect(list.json<{ data: MemberRow[] }>().data).toContainEqual(
      res.json<{ data: MemberRow }>().data
    )

    const audit = await archiveAuditRowsFor(owner.orgId, ADDED, jordan.userId)
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({
      actorUserId: owner.userId,
      payload: { projectId: project, role: 'member' },
    })
  })

  it('lets an org admin who is not a project member add (201)', async () => {
    const owner = await registerOwner(app, 'orgadmin-owner')
    const project = await createProject(app, owner.cookies, 'orgadmin-proj')
    const admin = await addUserToOrg(app, owner.orgId, 'orgadmin', { orgRole: 'admin' })
    const jordan = await addUserToOrg(app, owner.orgId, 'orgadmin-jordan')

    const res = await addMember(app, admin.cookies, project, {
      userId: jordan.userId,
      role: 'admin',
    })
    expect(res.statusCode).toBe(201)
    expect(await projectRoleOf(owner.orgId, project, jordan.userId)).toBe('admin')
  })

  it('lets a project admin (org viewer) add (201)', async () => {
    const owner = await registerOwner(app, 'projadmin-owner')
    const project = await createProject(app, owner.cookies, 'projadmin-proj')
    const admin = await addUserToOrg(app, owner.orgId, 'projadmin', { orgRole: 'viewer' })
    await addProjectMember(owner.orgId, project, admin.userId, 'admin')
    const jordan = await addUserToOrg(app, owner.orgId, 'projadmin-jordan')

    const res = await addMember(app, admin.cookies, project, {
      userId: jordan.userId,
      role: 'viewer',
    })
    expect(res.statusCode).toBe(201)
    expect(await projectRoleOf(owner.orgId, project, jordan.userId)).toBe('viewer')
  })

  it.each(['member', 'viewer'])('refuses a project %s: 403 and no audit', async (role) => {
    const owner = await registerOwner(app, `deny-${role}-owner`)
    const project = await createProject(app, owner.cookies, `deny-${role}-proj`)
    const caller = await addUserToOrg(app, owner.orgId, `deny-${role}`)
    await addProjectMember(owner.orgId, project, caller.userId, role)
    const jordan = await addUserToOrg(app, owner.orgId, `deny-${role}-jordan`)

    const res = await addMember(app, caller.cookies, project, {
      userId: jordan.userId,
      role: 'viewer',
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ code: 'insufficient_project_role' })
    expect(await projectRoleOf(owner.orgId, project, jordan.userId)).toBeUndefined()
    expect(await addedAuditCount(owner.orgId, jordan.userId)).toBe(0)
  })

  it('answers the same 404 for a cross-org user and a random uuid', async () => {
    const owner = await registerOwner(app, 'xorg-owner')
    const project = await createProject(app, owner.cookies, 'xorg-proj')
    const stranger = await registerOwner(app, 'xorg-stranger')

    const cross = await addMember(app, owner.cookies, project, {
      userId: stranger.userId,
      role: 'member',
    })
    const random = await addMember(app, owner.cookies, project, {
      userId: randomUUID(),
      role: 'member',
    })
    expect(cross.statusCode).toBe(404)
    expect(random.statusCode).toBe(404)
    expect(cross.json()).toStrictEqual(random.json())
    expect(cross.json()).toMatchObject({ code: 'user_not_found' })
    expect(await addedAuditCount(owner.orgId, stranger.userId)).toBe(0)
  })

  it('answers 404 for a deactivated org user', async () => {
    const owner = await registerOwner(app, 'deact-owner')
    const project = await createProject(app, owner.cookies, 'deact-proj')
    const jordan = await addUserToOrg(app, owner.orgId, 'deact-jordan')
    await withOrg(owner.orgId, (tx) =>
      tx
        .update(orgMemberships)
        .set({ status: 'deactivated' })
        .where(and(eq(orgMemberships.orgId, owner.orgId), eq(orgMemberships.userId, jordan.userId)))
    )

    const res = await addMember(app, owner.cookies, project, {
      userId: jordan.userId,
      role: 'member',
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ code: 'user_not_found' })
    expect(await projectRoleOf(owner.orgId, project, jordan.userId)).toBeUndefined()
  })

  describe('body validation', () => {
    it.each([
      ['role owner', { role: 'owner' }],
      ['unknown role', { role: 'superuser' }],
      ['unknown key', { role: 'member', extra: true }],
      ['missing role', {}],
    ])('rejects %s without a write', async (_name, extra) => {
      const owner = await registerOwner(app, 'body-owner')
      const project = await createProject(app, owner.cookies, 'body-proj')
      const jordan = await addUserToOrg(app, owner.orgId, 'body-jordan')

      const res = await addMember(app, owner.cookies, project, { userId: jordan.userId, ...extra })
      expect(res.statusCode).toBe(BODY_REJECTION_STATUS)
      expect(await projectRoleOf(owner.orgId, project, jordan.userId)).toBeUndefined()
      expect(await addedAuditCount(owner.orgId, jordan.userId)).toBe(0)
    })

    it('rejects a non-uuid userId', async () => {
      const owner = await registerOwner(app, 'body-uuid-owner')
      const project = await createProject(app, owner.cookies, 'body-uuid-proj')
      const res = await addMember(app, owner.cookies, project, { userId: 'nope', role: 'member' })
      expect(res.statusCode).toBe(BODY_REJECTION_STATUS)
    })
  })

  it('refuses a role above the caller rank at the helper (defence in depth)', async () => {
    const owner = await registerOwner(app, 'ceiling-owner')
    const project = await createProject(app, owner.cookies, 'ceiling-proj')
    const jordan = await addUserToOrg(app, owner.orgId, 'ceiling-jordan')

    const result = await withOrg(owner.orgId, (tx) =>
      addExistingOrgUserToProject(tx, {
        orgId: owner.orgId,
        projectId: project,
        userId: jordan.userId,
        role: 'admin',
        callerEffectiveRole: 'member',
      })
    )
    expect(result).toStrictEqual({ status: 'role_above_caller' })
    expect(await projectRoleOf(owner.orgId, project, jordan.userId)).toBeUndefined()
  })

  it('answers 410 for an archived project and 404 for a soft-deleted one, with no write', async () => {
    const owner = await registerOwner(app, 'state-owner')
    const archived = await createProject(app, owner.cookies, 'state-archived')
    const deleted = await createProject(app, owner.cookies, 'state-deleted')
    const jordan = await addUserToOrg(app, owner.orgId, 'state-jordan')
    await withOrg(owner.orgId, async (tx) => {
      await tx.update(projects).set({ archivedAt: new Date() }).where(eq(projects.id, archived))
      await tx.update(projects).set({ deletedAt: new Date() }).where(eq(projects.id, deleted))
    })

    const a = await addMember(app, owner.cookies, archived, {
      userId: jordan.userId,
      role: 'member',
    })
    expect(a.statusCode).toBe(410)
    expect(a.json()).toMatchObject({ code: 'project_archived' })
    const d = await addMember(app, owner.cookies, deleted, {
      userId: jordan.userId,
      role: 'member',
    })
    expect(d.statusCode).toBe(404)
    expect(await addedAuditCount(owner.orgId, jordan.userId)).toBe(0)
  })

  it('answers 404 for a project of another org', async () => {
    const owner = await registerOwner(app, 'foreign-owner')
    const other = await registerOwner(app, 'foreign-other')
    const foreignProject = await createProject(app, other.cookies, 'foreign-proj')
    const jordan = await addUserToOrg(app, owner.orgId, 'foreign-jordan')
    const res = await addMember(app, owner.cookies, foreignProject, {
      userId: jordan.userId,
      role: 'member',
    })
    expect(res.statusCode).toBe(404)
  })

  it('answers 409 already_member on a repeat, with no second audit event', async () => {
    const owner = await registerOwner(app, 'dup-owner')
    const project = await createProject(app, owner.cookies, 'dup-proj')
    const jordan = await addUserToOrg(app, owner.orgId, 'dup-jordan')

    expect(
      (await addMember(app, owner.cookies, project, { userId: jordan.userId, role: 'member' }))
        .statusCode
    ).toBe(201)
    const again = await addMember(app, owner.cookies, project, {
      userId: jordan.userId,
      role: 'admin',
    })
    expect(again.statusCode).toBe(409)
    expect(again.json()).toMatchObject({ code: 'already_member' })
    expect(await projectRoleOf(owner.orgId, project, jordan.userId)).toBe('member')
    expect(await addedAuditCount(owner.orgId, jordan.userId)).toBe(1)
  })

  it('answers 409 for an existing owner row and leaves the last-owner rules untouched', async () => {
    const owner = await registerOwner(app, 'lastowner-owner')
    const project = await createProject(app, owner.cookies, 'lastowner-proj')
    const res = await addMember(app, owner.cookies, project, {
      userId: owner.userId,
      role: 'viewer',
    })
    expect(res.statusCode).toBe(409)
    expect(await projectRoleOf(owner.orgId, project, owner.userId)).toBe('owner')
  })

  it('settles a concurrent double add as one 201 and one 409, with one audit event', async () => {
    const owner = await registerOwner(app, 'race-owner')
    const project = await createProject(app, owner.cookies, 'race-proj')
    const jordan = await addUserToOrg(app, owner.orgId, 'race-jordan')

    const results = await Promise.all([
      addMember(app, owner.cookies, project, { userId: jordan.userId, role: 'member' }),
      addMember(app, owner.cookies, project, { userId: jordan.userId, role: 'member' }),
    ])
    expect(results.map((r) => r.statusCode).sort()).toStrictEqual([201, 409])
    expect(await addedAuditCount(owner.orgId, jordan.userId)).toBe(1)
  })

  it('refuses a caller without MFA enrollment (strict gate, grace period ignored)', async () => {
    const unenrolled = await registerAndLoginViaApi(app, {
      email: `addmember-nomfa-${randomUUID()}@example.com`,
      password: 'correct-horse-battery-staple',
      orgName: `AddMember NoMfa ${randomUUID()}`,
    })
    const project = await createProject(app, unenrolled.cookies, 'nomfa-proj')
    const res = await addMember(app, unenrolled.cookies, project, {
      userId: randomUUID(),
      role: 'member',
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ code: 'mfa_required' })
  })

  it('rate-limits at 30 per minute with the body-shape 429', async () => {
    const owner = await registerOwner(app, 'rate-owner')
    const project = await createProject(app, owner.cookies, 'rate-proj')
    const body = { userId: randomUUID(), role: 'member' }
    process.env['RATE_LIMIT_TEST_BYPASS'] = 'false'
    const results: Awaited<ReturnType<typeof addMember>>[] = []
    await forEachSequential(Array.from({ length: 31 }), async () => {
      results.push(await addMember(app, owner.cookies, project, body))
    })
    const limited = results.filter((r) => r.statusCode === 429)
    expect(limited).toHaveLength(1)
    expect(limited[0]?.json()).toMatchObject({ code: 'rate_limit_exceeded', retryAfter: 60 })
    expect(limited[0]?.headers['retry-after']).toBeUndefined()
  })
})
