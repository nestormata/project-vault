import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import {
  auditLogEntries,
  orgMemberships,
  projectMemberships,
  projects,
} from '@project-vault/db/schema'
import { createApp } from '../../app.js'
import {
  configureAuthIntegrationEnv,
  initVaultForTest,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import { checkProjectAuthorization } from '../../lib/project-authorization.js'
import { runWithRequestContext } from '../../lib/request-context.js'
import { roleRank } from '../../lib/secure-route.js'
import type { OrgRole } from '../../plugins/require-org-role.js'

const TOKEN = 'test-only-service-provisioning-token-32-bytes-min'
const TOKEN_HEADER = 'x-service-provisioning-token'
const ORG_URL = '/api/v1/service/organizations'
const WRONG_TOKEN = 'definitely-wrong-token-value-000000'
const VAULT_SECRET = 'service-project-access-read-routes-vault-secret'

async function freshVaultBackedApp(vaultSecret: string) {
  await resetVaultForTest()
  const { initVault } = await import('../../modules/vault/key-service.js')
  await initVaultForTest(initVault, vaultSecret)
  return createApp({ logger: false, vaultGuardEnabled: true })
}

type InjectResponse = Awaited<ReturnType<Awaited<ReturnType<typeof createApp>>['inject']>>
type ErrorBody = { code: string; message: string }
type AccessItem = {
  projectId: string
  effectiveRole: OrgRole
  grantSource: 'role' | 'direct'
}
type AccessBody = {
  data: { userId: string; items: AccessItem[]; groupGrantEvaluation: 'not_evaluated' }
}

function errorBody(res: InjectResponse): ErrorBody {
  return res.json() as ErrorBody
}

function accessUrl(organizationId: string, userId: string): string {
  return `${ORG_URL}/${organizationId}/users/${userId}/project-access`
}

describe('Story 73.6 service effective project-access read', () => {
  let originalToken: string | undefined

  beforeEach(async () => {
    configureAuthIntegrationEnv()
    const { env } = await import('../../config/env.js')
    originalToken = (env as unknown as Record<string, unknown>)['SERVICE_PROVISIONING_TOKEN'] as
      string | undefined
    ;(env as unknown as Record<string, unknown>)['SERVICE_PROVISIONING_TOKEN'] = TOKEN
  })

  afterEach(async () => {
    const { env } = await import('../../config/env.js')
    ;(env as unknown as Record<string, unknown>)['SERVICE_PROVISIONING_TOKEN'] = originalToken
    await resetVaultForTest()
  })

  async function freshApp() {
    return freshVaultBackedApp(VAULT_SECRET)
  }

  async function createOrg(app: Awaited<ReturnType<typeof createApp>>, suffix = '') {
    const requestId = randomUUID()
    const res = await app.inject({
      method: 'POST',
      url: ORG_URL,
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: {
        requestId,
        organizationName: `Access Read Org ${requestId}${suffix}`,
        workosUserId: `owner_${requestId}`,
        centralizemeOrganizationId: `org_synthetic_${requestId}`,
      },
    })
    const data = (res.json() as { data: { organizationId: string; userId: string } }).data
    return { organizationId: data.organizationId, ownerUserId: data.userId }
  }

  async function addOrgMember(
    app: Awaited<ReturnType<typeof createApp>>,
    organizationId: string,
    role?: string
  ) {
    const payload: { requestId: string; workosUserId: string; role?: string } = {
      requestId: randomUUID(),
      workosUserId: `user_${randomUUID()}`,
    }
    if (role !== undefined) payload.role = role
    const res = await app.inject({
      method: 'POST',
      url: `${ORG_URL}/${organizationId}/members`,
      headers: { [TOKEN_HEADER]: TOKEN },
      payload,
    })
    return (res.json() as { data: { userId: string } }).data.userId
  }

  async function seedProject(orgId: string, ownerUserId: string): Promise<string> {
    const [project] = await withOrg(orgId, (tx) =>
      tx
        .insert(projects)
        .values({
          orgId,
          name: `proj-${randomUUID()}`,
          slug: `proj-${randomUUID()}`,
          createdBy: ownerUserId,
        })
        .returning({ id: projects.id })
    )
    if (!project) throw new Error('expected project')
    await withOrg(orgId, (tx) =>
      tx.insert(projectMemberships).values({
        orgId,
        projectId: project.id,
        userId: ownerUserId,
        role: 'owner',
      })
    )
    return project.id
  }

  async function addProjectMember(
    app: Awaited<ReturnType<typeof createApp>>,
    organizationId: string,
    projectId: string,
    userId: string,
    role: string
  ) {
    const res = await app.inject({
      method: 'POST',
      url: `${ORG_URL}/${organizationId}/projects/${projectId}/members`,
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: { requestId: randomUUID(), userId, role },
    })
    expect(res.statusCode).toBe(201)
  }

  async function readAccess(
    app: Awaited<ReturnType<typeof createApp>>,
    organizationId: string,
    userId: string,
    token = TOKEN
  ) {
    return app.inject({
      method: 'GET',
      url: accessUrl(organizationId, userId),
      headers: { [TOKEN_HEADER]: token },
    })
  }

  async function nextRankCheck(
    orgId: string,
    subjectUserId: string,
    projectId: string,
    effectiveRole: OrgRole
  ) {
    const ranks: OrgRole[] = ['viewer', 'member', 'admin', 'owner']
    const next = ranks.find((role) => roleRank(role) === roleRank(effectiveRole) + 1)
    if (!next) return
    const outcome = await runWithRequestContext({ orgId, userId: subjectUserId }, () =>
      checkProjectAuthorization(
        { viewerIdentityId: subjectUserId, projectId, minimumRole: next },
        { extensionName: 'story-73-6-matrix' }
      )
    )
    expect(outcome.outcome).toBe('denied')
  }

  it('returns role source for an org admin across active projects', async () => {
    const app = await freshApp()
    const { organizationId, ownerUserId } = await createOrg(app)
    const adminId = await addOrgMember(app, organizationId, 'admin')
    const projectA = await seedProject(organizationId, ownerUserId)
    const projectB = await seedProject(organizationId, ownerUserId)

    const res = await readAccess(app, organizationId, adminId)
    expect(res.statusCode).toBe(200)
    const body = res.json() as AccessBody
    expect(body.data.userId).toBe(adminId)
    expect(body.data.groupGrantEvaluation).toBe('not_evaluated')
    expect(body.data.items).toEqual(
      [projectA, projectB].sort().map((projectId) => ({
        projectId,
        effectiveRole: 'admin',
        grantSource: 'role',
      }))
    )
    await app.close()
  })

  it('returns direct source for an org member with one project viewer row', async () => {
    const app = await freshApp()
    const { organizationId, ownerUserId } = await createOrg(app)
    const memberId = await addOrgMember(app, organizationId, 'member')
    const visible = await seedProject(organizationId, ownerUserId)
    await seedProject(organizationId, ownerUserId)
    await addProjectMember(app, organizationId, visible, memberId, 'viewer')

    const res = await readAccess(app, organizationId, memberId)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      data: {
        userId: memberId,
        items: [{ projectId: visible, effectiveRole: 'viewer', grantSource: 'direct' }],
        groupGrantEvaluation: 'not_evaluated',
      },
    })
    await app.close()
  })

  it('keeps role source for an org admin even when a lower project row exists', async () => {
    const app = await freshApp()
    const { organizationId, ownerUserId } = await createOrg(app)
    const adminId = await addOrgMember(app, organizationId, 'admin')
    const projectId = await seedProject(organizationId, ownerUserId)
    await addProjectMember(app, organizationId, projectId, adminId, 'viewer')

    const res = await readAccess(app, organizationId, adminId)
    expect(res.statusCode).toBe(200)
    expect((res.json() as AccessBody).data.items).toEqual([
      { projectId, effectiveRole: 'admin', grantSource: 'role' },
    ])
    await app.close()
  })

  it('omits archived and soft-deleted projects', async () => {
    const app = await freshApp()
    const { organizationId, ownerUserId } = await createOrg(app)
    const adminId = await addOrgMember(app, organizationId, 'admin')
    const live = await seedProject(organizationId, ownerUserId)
    const archived = await seedProject(organizationId, ownerUserId)
    const deleted = await seedProject(organizationId, ownerUserId)
    await withOrg(organizationId, (tx) =>
      tx.update(projects).set({ archivedAt: new Date() }).where(eq(projects.id, archived))
    )
    await withOrg(organizationId, (tx) =>
      tx
        .update(projects)
        .set({ deletedAt: new Date(), archivedAt: new Date() })
        .where(eq(projects.id, deleted))
    )

    const res = await readAccess(app, organizationId, adminId)
    expect(res.statusCode).toBe(200)
    expect((res.json() as AccessBody).data.items.map((item) => item.projectId)).toEqual([live])
    await app.close()
  })

  it('returns the same empty 200 for a missing user, a group-only member, and a foreign-org user', async () => {
    const app = await freshApp()
    const orgA = await createOrg(app, '-a')
    const orgB = await createOrg(app, '-b')
    await seedProject(orgA.organizationId, orgA.ownerUserId)
    const groupOnly = await addOrgMember(app, orgA.organizationId, 'member')
    const foreign = await addOrgMember(app, orgB.organizationId, 'member')
    const missingUser = randomUUID()

    const empty = {
      items: [],
      groupGrantEvaluation: 'not_evaluated',
    }
    const missing = await readAccess(app, orgA.organizationId, missingUser)
    const group = await readAccess(app, orgA.organizationId, groupOnly)
    const cross = await readAccess(app, orgA.organizationId, foreign)

    expect(missing.statusCode).toBe(200)
    expect(group.statusCode).toBe(200)
    expect(cross.statusCode).toBe(200)
    expect(missing.json()).toEqual({ data: { userId: missingUser, ...empty } })
    expect(group.json()).toEqual({ data: { userId: groupOnly, ...empty } })
    expect(cross.json()).toEqual({ data: { userId: foreign, ...empty } })
    await app.close()
  })

  it('never writes audit_log_entries on a successful read', async () => {
    const app = await freshApp()
    const { organizationId, ownerUserId } = await createOrg(app)
    const adminId = await addOrgMember(app, organizationId, 'admin')
    await seedProject(organizationId, ownerUserId)
    const before = await withOrg(organizationId, (tx) =>
      tx.select({ id: auditLogEntries.id }).from(auditLogEntries)
    )
    await readAccess(app, organizationId, adminId)
    const after = await withOrg(organizationId, (tx) =>
      tx.select({ id: auditLogEntries.id }).from(auditLogEntries)
    )
    expect(after).toHaveLength(before.length)
    await app.close()
  })

  it('answers 404 organization_not_found for a missing org and 403 for an unmanaged org', async () => {
    const app = await freshApp()
    const missing = await readAccess(app, randomUUID(), randomUUID())
    expect(missing.statusCode).toBe(404)
    expect(errorBody(missing).code).toBe('organization_not_found')

    const unmanaged = await app.inject({
      method: 'POST',
      url: ORG_URL,
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: {
        requestId: randomUUID(),
        organizationName: `Unmanaged ${randomUUID()}`,
        workosUserId: `owner_${randomUUID()}`,
      },
    })
    const organizationId = (unmanaged.json() as { data: { organizationId: string } }).data
      .organizationId
    const res = await readAccess(app, organizationId, randomUUID())
    expect(res.statusCode).toBe(403)
    expect(errorBody(res).code).toBe('organization_not_centralizeme_managed')
    await app.close()
  })

  it('rejects a missing or wrong token with 403 and a malformed id with 422', async () => {
    const app = await freshApp()
    const { organizationId, ownerUserId } = await createOrg(app)
    const noToken = await app.inject({
      method: 'GET',
      url: accessUrl(organizationId, ownerUserId),
    })
    const wrong = await readAccess(app, organizationId, ownerUserId, WRONG_TOKEN)
    const malformed = await app.inject({
      method: 'GET',
      url: accessUrl('not-a-uuid', ownerUserId),
      headers: { [TOKEN_HEADER]: TOKEN },
    })
    expect(noToken.statusCode).toBe(403)
    expect(wrong.statusCode).toBe(403)
    expect(malformed.statusCode).toBe(422)
    await app.close()
  })

  it('does not list org B projects when the URL names org A', async () => {
    const app = await freshApp()
    const orgA = await createOrg(app, '-iso-a')
    const orgB = await createOrg(app, '-iso-b')
    const adminA = await addOrgMember(app, orgA.organizationId, 'admin')
    await seedProject(orgA.organizationId, orgA.ownerUserId)
    const projectB = await seedProject(orgB.organizationId, orgB.ownerUserId)

    const res = await readAccess(app, orgA.organizationId, adminA)
    const ids = (res.json() as AccessBody).data.items.map((item) => item.projectId)
    expect(ids).not.toContain(projectB)
    await app.close()
  })

  it.each([
    { label: 'admin', orgRole: 'admin' as const, projectRole: undefined, source: 'role' as const },
    {
      label: 'member',
      orgRole: 'member' as const,
      projectRole: 'member' as const,
      source: 'direct' as const,
    },
    {
      label: 'viewer',
      orgRole: 'viewer' as const,
      projectRole: 'viewer' as const,
      source: 'direct' as const,
    },
    {
      label: 'direct-only',
      orgRole: 'member' as const,
      projectRole: 'admin' as const,
      source: 'direct' as const,
    },
    { label: 'group-only', orgRole: 'member' as const, projectRole: undefined, source: undefined },
  ])(
    'matrix $label agrees with PV visibility and checkProjectMembership on returned items',
    async ({ orgRole, projectRole, source }) => {
      const app = await freshApp()
      const { organizationId, ownerUserId } = await createOrg(app)
      const subjectId = await addOrgMember(app, organizationId, orgRole)
      const projectId = await seedProject(organizationId, ownerUserId)
      const otherProject = await seedProject(organizationId, ownerUserId)
      if (projectRole) {
        await addProjectMember(app, organizationId, projectId, subjectId, projectRole)
      }

      const res = await readAccess(app, organizationId, subjectId)
      expect(res.statusCode).toBe(200)
      const items = (res.json() as AccessBody).data.items
      if (source === undefined) {
        expect(items).toEqual([])
        await app.close()
        return
      }
      if (orgRole === 'admin') {
        expect(new Set(items.map((item) => item.projectId))).toEqual(
          new Set([projectId, otherProject])
        )
        expect(
          items.every((item) => item.effectiveRole === 'admin' && item.grantSource === 'role')
        ).toBe(true)
      } else {
        expect(items).toEqual([{ projectId, effectiveRole: projectRole, grantSource: source }])
        expect(items.some((item) => item.projectId === otherProject)).toBe(false)
      }
      const expectedRole = (orgRole === 'admin' ? 'admin' : projectRole) as OrgRole
      const atRole = await runWithRequestContext({ orgId: organizationId, userId: subjectId }, () =>
        checkProjectAuthorization(
          {
            viewerIdentityId: subjectId,
            projectId,
            minimumRole: expectedRole,
          },
          { extensionName: 'story-73-6-matrix' }
        )
      )
      expect(atRole).toEqual({ outcome: 'authorized' })
      await nextRankCheck(organizationId, subjectId, projectId, expectedRole)
      await app.close()
    }
  )

  it('the 61st read in a minute is 429 rate_limit_exceeded', async () => {
    const previousBypass = process.env['RATE_LIMIT_TEST_BYPASS']
    process.env['RATE_LIMIT_TEST_BYPASS'] = 'false'
    const app = await freshApp()
    const { organizationId, ownerUserId } = await createOrg(app)
    const last = await Array.from({ length: 61 }, () => null).reduce<
      Promise<InjectResponse | undefined>
    >(async (prev) => {
      const prior = await prev
      if (prior?.statusCode === 429) return prior
      return readAccess(app, organizationId, ownerUserId)
    }, Promise.resolve(undefined))
    expect(last?.statusCode).toBe(429)
    expect(errorBody(last as InjectResponse).code).toBe('rate_limit_exceeded')
    await app.close()
    process.env['RATE_LIMIT_TEST_BYPASS'] = previousBypass
  })

  it('does not leak org membership rows across tenants via the list', async () => {
    const app = await freshApp()
    const orgA = await createOrg(app, '-rls-a')
    const orgB = await createOrg(app, '-rls-b')
    const memberB = await addOrgMember(app, orgB.organizationId, 'member')
    const projectB = await seedProject(orgB.organizationId, orgB.ownerUserId)
    await addProjectMember(app, orgB.organizationId, projectB, memberB, 'member')

    const res = await readAccess(app, orgA.organizationId, memberB)
    expect(res.statusCode).toBe(200)
    expect((res.json() as AccessBody).data.items).toEqual([])
    const stillInB = await withOrg(orgB.organizationId, (tx) =>
      tx
        .select({ userId: orgMemberships.userId })
        .from(orgMemberships)
        .where(
          and(eq(orgMemberships.orgId, orgB.organizationId), eq(orgMemberships.userId, memberB))
        )
    )
    expect(stillInB).toHaveLength(1)
    await app.close()
  })
})
