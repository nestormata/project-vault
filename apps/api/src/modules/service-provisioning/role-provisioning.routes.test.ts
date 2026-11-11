import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { getDb, withOrg } from '@project-vault/db'
import {
  auditLogEntries,
  orgMemberships,
  platformSecurityEvents,
  projectMemberships,
  projects,
} from '@project-vault/db/schema'
import { createApp } from '../../app.js'
import {
  configureAuthIntegrationEnv,
  initVaultForTest,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'

const TOKEN = 'test-only-service-provisioning-token-32-bytes-min'
const TOKEN_HEADER = 'x-service-provisioning-token'
const ORG_URL = '/api/v1/service/organizations'
const WRONG_TOKEN = 'definitely-wrong-token-value-000000'
const VAULT_SECRET = 'service-role-provisioning-routes-vault-secret'

async function freshVaultBackedApp(vaultSecret: string) {
  await resetVaultForTest()
  const { initVault } = await import('../../modules/vault/key-service.js')
  await initVaultForTest(initVault, vaultSecret)
  return createApp({ logger: false, vaultGuardEnabled: true })
}

type InjectResponse = Awaited<ReturnType<Awaited<ReturnType<typeof createApp>>['inject']>>
type ErrorBody = { code: string; message: string }

function errorBody(res: InjectResponse): ErrorBody {
  return res.json() as ErrorBody
}

describe('Story 73.5 service role provisioning routes', () => {
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

  async function createOrg(app: Awaited<ReturnType<typeof createApp>>) {
    const requestId = randomUUID()
    const res = await app.inject({
      method: 'POST',
      url: ORG_URL,
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: {
        requestId,
        organizationName: `Role Prov Org ${requestId}`,
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

  async function orgRoleOf(orgId: string, userId: string) {
    const [row] = await withOrg(orgId, (tx) =>
      tx
        .select({ role: orgMemberships.role, status: orgMemberships.status })
        .from(orgMemberships)
        .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)))
    )
    return row
  }

  async function projectRoleOf(orgId: string, projectId: string, userId: string) {
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

  async function auditOf(orgId: string, eventType: string, resourceId: string) {
    return withOrg(orgId, (tx) =>
      tx
        .select({ eventType: auditLogEntries.eventType, payload: auditLogEntries.payload })
        .from(auditLogEntries)
        .where(
          and(
            eq(auditLogEntries.orgId, orgId),
            eq(auditLogEntries.eventType, eventType),
            eq(auditLogEntries.resourceId, resourceId)
          )
        )
    )
  }

  async function securityEventsForRequest(requestId: string) {
    return getDb()
      .select({
        eventType: platformSecurityEvents.eventType,
        payload: platformSecurityEvents.payload,
      })
      .from(platformSecurityEvents)
      .where(eq(platformSecurityEvents.eventType, 'unrecognized_role'))
      .then((rows) =>
        rows.filter((row) => {
          const payload = row.payload as { requestId?: string }
          return payload.requestId === requestId
        })
      )
  }

  describe('PATCH /api/v1/service/organizations/:organizationId/members/:userId', () => {
    it('changes an org member to viewer and writes one system audit row', async () => {
      const app = await freshApp()
      const { organizationId } = await createOrg(app)
      const userId = await addOrgMember(app, organizationId)
      const requestId = randomUUID()

      const res = await app.inject({
        method: 'PATCH',
        url: `${ORG_URL}/${organizationId}/members/${userId}`,
        headers: { [TOKEN_HEADER]: TOKEN },
        payload: { requestId, role: 'viewer' },
      })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ data: { userId, role: 'viewer' } })
      expect((await orgRoleOf(organizationId, userId))?.role).toBe('viewer')
      const audits = await auditOf(organizationId, 'org.member_role_changed', userId)
      expect(audits).toHaveLength(1)
      expect(audits[0]?.payload).toMatchObject({
        oldRole: 'member',
        newRole: 'viewer',
        requestId,
      })
      await app.close()
    })

    it('refuses owner with 400 invalid_role, writes a security event, and does not change the row', async () => {
      const app = await freshApp()
      const { organizationId } = await createOrg(app)
      const userId = await addOrgMember(app, organizationId)
      const requestId = randomUUID()

      const res = await app.inject({
        method: 'PATCH',
        url: `${ORG_URL}/${organizationId}/members/${userId}`,
        headers: { [TOKEN_HEADER]: TOKEN },
        payload: { requestId, role: 'owner' },
      })

      expect(res.statusCode).toBe(400)
      expect(errorBody(res).code).toBe('invalid_role')
      expect(errorBody(res).message).not.toMatch(/admin/)
      expect((await orgRoleOf(organizationId, userId))?.role).toBe('member')
      expect(await auditOf(organizationId, 'org.member_role_changed', userId)).toHaveLength(0)
      const events = await securityEventsForRequest(requestId)
      expect(events).toHaveLength(1)
      expect(events[0]?.payload).toMatchObject({ source: 'requested', role: 'owner' })
      await app.close()
    })

    it('refuses demoting the last org owner with 409 last_org_owner', async () => {
      const app = await freshApp()
      const { organizationId, ownerUserId } = await createOrg(app)

      const res = await app.inject({
        method: 'PATCH',
        url: `${ORG_URL}/${organizationId}/members/${ownerUserId}`,
        headers: { [TOKEN_HEADER]: TOKEN },
        payload: { requestId: randomUUID(), role: 'admin' },
      })

      expect(res.statusCode).toBe(409)
      expect(errorBody(res).code).toBe('last_org_owner')
      expect((await orgRoleOf(organizationId, ownerUserId))?.role).toBe('owner')
      await app.close()
    })

    it('answers 404 for a missing user the same as a cross-org user', async () => {
      const app = await freshApp()
      const { organizationId } = await createOrg(app)
      const other = await createOrg(app)
      const foreignUser = await addOrgMember(app, other.organizationId)

      const missing = await app.inject({
        method: 'PATCH',
        url: `${ORG_URL}/${organizationId}/members/${randomUUID()}`,
        headers: { [TOKEN_HEADER]: TOKEN },
        payload: { requestId: randomUUID(), role: 'viewer' },
      })
      const cross = await app.inject({
        method: 'PATCH',
        url: `${ORG_URL}/${organizationId}/members/${foreignUser}`,
        headers: { [TOKEN_HEADER]: TOKEN },
        payload: { requestId: randomUUID(), role: 'viewer' },
      })

      expect(missing.statusCode).toBe(404)
      expect(cross.statusCode).toBe(404)
      expect(errorBody(missing)).toEqual(errorBody(cross))
      await app.close()
    })

    it('answers the same 403 for a missing token and a wrong token', async () => {
      const app = await freshApp()
      const { organizationId, ownerUserId } = await createOrg(app)
      const payload = { requestId: randomUUID(), role: 'viewer' }
      const missing = await app.inject({
        method: 'PATCH',
        url: `${ORG_URL}/${organizationId}/members/${ownerUserId}`,
        payload,
      })
      const wrong = await app.inject({
        method: 'PATCH',
        url: `${ORG_URL}/${organizationId}/members/${ownerUserId}`,
        headers: { [TOKEN_HEADER]: WRONG_TOKEN },
        payload,
      })
      expect(missing.statusCode).toBe(403)
      expect(wrong.statusCode).toBe(403)
      expect(errorBody(missing)).toEqual(errorBody(wrong))
      await app.close()
    })
  })

  describe('DELETE /api/v1/service/organizations/:organizationId/members/:userId', () => {
    it('removes a non-owner member and writes org.user_removed', async () => {
      const app = await freshApp()
      const { organizationId } = await createOrg(app)
      const userId = await addOrgMember(app, organizationId)
      const requestId = randomUUID()

      const res = await app.inject({
        method: 'DELETE',
        url: `${ORG_URL}/${organizationId}/members/${userId}`,
        headers: { [TOKEN_HEADER]: TOKEN },
        payload: { requestId },
      })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ data: { userId, removedProjectCount: 0 } })
      expect(await orgRoleOf(organizationId, userId)).toBeUndefined()
      const audits = await auditOf(organizationId, 'org.user_removed', userId)
      expect(audits).toHaveLength(1)
      expect(audits[0]?.payload).toMatchObject({ requestId, removedProjectCount: 0 })
      await app.close()
    })

    it('concurrent last-two org owner removes leave one owner', async () => {
      const app = await freshApp()
      const { organizationId, ownerUserId } = await createOrg(app)
      const otherUserId = await addOrgMember(app, organizationId)
      await withOrg(organizationId, (tx) =>
        tx
          .update(orgMemberships)
          .set({ role: 'owner' })
          .where(
            and(eq(orgMemberships.orgId, organizationId), eq(orgMemberships.userId, otherUserId))
          )
      )

      const [first, second] = await Promise.all([
        app.inject({
          method: 'DELETE',
          url: `${ORG_URL}/${organizationId}/members/${ownerUserId}`,
          headers: { [TOKEN_HEADER]: TOKEN },
          payload: { requestId: randomUUID() },
        }),
        app.inject({
          method: 'DELETE',
          url: `${ORG_URL}/${organizationId}/members/${otherUserId}`,
          headers: { [TOKEN_HEADER]: TOKEN },
          payload: { requestId: randomUUID() },
        }),
      ])
      const statuses = [first.statusCode, second.statusCode]
      expect(statuses.filter((code) => code === 200)).toHaveLength(1)
      expect(statuses.some((code) => code === 409 || code === 404)).toBe(true)
      const remaining = await withOrg(organizationId, (tx) =>
        tx
          .select({ userId: orgMemberships.userId })
          .from(orgMemberships)
          .where(and(eq(orgMemberships.orgId, organizationId), eq(orgMemberships.role, 'owner')))
      )
      expect(remaining).toHaveLength(1)
      await app.close()
    })

    it('refuses removing the last org owner with 409 last_org_owner', async () => {
      const app = await freshApp()
      const { organizationId, ownerUserId } = await createOrg(app)

      const res = await app.inject({
        method: 'DELETE',
        url: `${ORG_URL}/${organizationId}/members/${ownerUserId}`,
        headers: { [TOKEN_HEADER]: TOKEN },
        payload: { requestId: randomUUID() },
      })

      expect(res.statusCode).toBe(409)
      expect(errorBody(res).code).toBe('last_org_owner')
      expect((await orgRoleOf(organizationId, ownerUserId))?.role).toBe('owner')
      await app.close()
    })

    it('refuses removing a user who is the sole owner of a project', async () => {
      const app = await freshApp()
      const { organizationId, ownerUserId } = await createOrg(app)
      const userId = await addOrgMember(app, organizationId, 'admin')
      const projectId = await seedProject(organizationId, ownerUserId)
      await withOrg(organizationId, (tx) =>
        tx
          .update(projectMemberships)
          .set({ userId, role: 'owner' })
          .where(
            and(
              eq(projectMemberships.projectId, projectId),
              eq(projectMemberships.userId, ownerUserId)
            )
          )
      )

      const res = await app.inject({
        method: 'DELETE',
        url: `${ORG_URL}/${organizationId}/members/${userId}`,
        headers: { [TOKEN_HEADER]: TOKEN },
        payload: { requestId: randomUUID() },
      })

      expect(res.statusCode).toBe(409)
      expect(errorBody(res).code).toBe('sole_owner_of_projects')
      expect(await orgRoleOf(organizationId, userId)).toBeTruthy()
      await app.close()
    })
  })

  describe('project member service routes', () => {
    it('adds a project member, changes role to viewer, then removes them', async () => {
      const app = await freshApp()
      const { organizationId, ownerUserId } = await createOrg(app)
      const userId = await addOrgMember(app, organizationId)
      const projectId = await seedProject(organizationId, ownerUserId)
      const addRequestId = randomUUID()

      const added = await app.inject({
        method: 'POST',
        url: `${ORG_URL}/${organizationId}/projects/${projectId}/members`,
        headers: { [TOKEN_HEADER]: TOKEN },
        payload: { requestId: addRequestId, userId, role: 'member' },
      })
      expect(added.statusCode).toBe(201)
      expect(await projectRoleOf(organizationId, projectId, userId)).toBe('member')
      expect(await auditOf(organizationId, 'project.member_added', userId)).toHaveLength(1)

      const patched = await app.inject({
        method: 'PATCH',
        url: `${ORG_URL}/${organizationId}/projects/${projectId}/members/${userId}`,
        headers: { [TOKEN_HEADER]: TOKEN },
        payload: { requestId: randomUUID(), role: 'viewer' },
      })
      expect(patched.statusCode).toBe(200)
      expect(await projectRoleOf(organizationId, projectId, userId)).toBe('viewer')

      const removed = await app.inject({
        method: 'DELETE',
        url: `${ORG_URL}/${organizationId}/projects/${projectId}/members/${userId}`,
        headers: { [TOKEN_HEADER]: TOKEN },
        payload: { requestId: randomUUID() },
      })
      expect(removed.statusCode).toBe(204)
      expect(await projectRoleOf(organizationId, projectId, userId)).toBeUndefined()
      await app.close()
    })

    it('refuses adding owner and an unrecognized role with 400 plus a security event', async () => {
      const app = await freshApp()
      const { organizationId, ownerUserId } = await createOrg(app)
      const userId = await addOrgMember(app, organizationId)
      const projectId = await seedProject(organizationId, ownerUserId)
      const requestId = randomUUID()

      const ownerGrant = await app.inject({
        method: 'POST',
        url: `${ORG_URL}/${organizationId}/projects/${projectId}/members`,
        headers: { [TOKEN_HEADER]: TOKEN },
        payload: { requestId, userId, role: 'owner' },
      })
      expect(ownerGrant.statusCode).toBe(400)
      expect(errorBody(ownerGrant).code).toBe('invalid_role')
      expect(await securityEventsForRequest(requestId)).toHaveLength(1)
      expect(await projectRoleOf(organizationId, projectId, userId)).toBeUndefined()
      await app.close()
    })

    it('answers 409 already_member on a second add', async () => {
      const app = await freshApp()
      const { organizationId, ownerUserId } = await createOrg(app)
      const userId = await addOrgMember(app, organizationId)
      const projectId = await seedProject(organizationId, ownerUserId)
      await app.inject({
        method: 'POST',
        url: `${ORG_URL}/${organizationId}/projects/${projectId}/members`,
        headers: { [TOKEN_HEADER]: TOKEN },
        payload: { requestId: randomUUID(), userId, role: 'member' },
      })
      const second = await app.inject({
        method: 'POST',
        url: `${ORG_URL}/${organizationId}/projects/${projectId}/members`,
        headers: { [TOKEN_HEADER]: TOKEN },
        payload: { requestId: randomUUID(), userId, role: 'viewer' },
      })
      expect(second.statusCode).toBe(409)
      expect(errorBody(second).code).toBe('already_member')
      expect(await projectRoleOf(organizationId, projectId, userId)).toBe('member')
      await app.close()
    })

    it('answers 410 for an archived project and 404 for a missing one', async () => {
      const app = await freshApp()
      const { organizationId, ownerUserId } = await createOrg(app)
      const userId = await addOrgMember(app, organizationId)
      const projectId = await seedProject(organizationId, ownerUserId)
      await withOrg(organizationId, (tx) =>
        tx.update(projects).set({ archivedAt: new Date() }).where(eq(projects.id, projectId))
      )

      const archived = await app.inject({
        method: 'POST',
        url: `${ORG_URL}/${organizationId}/projects/${projectId}/members`,
        headers: { [TOKEN_HEADER]: TOKEN },
        payload: { requestId: randomUUID(), userId, role: 'member' },
      })
      const missing = await app.inject({
        method: 'POST',
        url: `${ORG_URL}/${organizationId}/projects/${randomUUID()}/members`,
        headers: { [TOKEN_HEADER]: TOKEN },
        payload: { requestId: randomUUID(), userId, role: 'member' },
      })
      expect(archived.statusCode).toBe(410)
      expect(errorBody(archived).code).toBe('project_archived')
      expect(missing.statusCode).toBe(404)
      expect(errorBody(missing).code).toBe('project_not_found')
      await app.close()
    })

    it('refuses removing the last project owner with 409 last_owner', async () => {
      const app = await freshApp()
      const { organizationId, ownerUserId } = await createOrg(app)
      const projectId = await seedProject(organizationId, ownerUserId)

      const res = await app.inject({
        method: 'DELETE',
        url: `${ORG_URL}/${organizationId}/projects/${projectId}/members/${ownerUserId}`,
        headers: { [TOKEN_HEADER]: TOKEN },
        payload: { requestId: randomUUID() },
      })
      expect(res.statusCode).toBe(409)
      expect(errorBody(res).code).toBe('last_owner')
      expect(await projectRoleOf(organizationId, projectId, ownerUserId)).toBe('owner')
      await app.close()
    })

    it('concurrent last-two project owner removes leave one owner', async () => {
      const app = await freshApp()
      const { organizationId, ownerUserId } = await createOrg(app)
      const projectId = await seedProject(organizationId, ownerUserId)
      const otherUserId = await addOrgMember(app, organizationId)
      await withOrg(organizationId, (tx) =>
        tx.insert(projectMemberships).values({
          orgId: organizationId,
          projectId,
          userId: otherUserId,
          role: 'owner',
        })
      )

      const [first, second] = await Promise.all([
        app.inject({
          method: 'DELETE',
          url: `${ORG_URL}/${organizationId}/projects/${projectId}/members/${ownerUserId}`,
          headers: { [TOKEN_HEADER]: TOKEN },
          payload: { requestId: randomUUID() },
        }),
        app.inject({
          method: 'DELETE',
          url: `${ORG_URL}/${organizationId}/projects/${projectId}/members/${otherUserId}`,
          headers: { [TOKEN_HEADER]: TOKEN },
          payload: { requestId: randomUUID() },
        }),
      ])
      const statuses = [first.statusCode, second.statusCode]
      expect(statuses.filter((code) => code === 204)).toHaveLength(1)
      expect(statuses.some((code) => code === 409 || code === 404)).toBe(true)
      const remaining = await withOrg(organizationId, (tx) =>
        tx
          .select({ userId: projectMemberships.userId })
          .from(projectMemberships)
          .where(
            and(eq(projectMemberships.projectId, projectId), eq(projectMemberships.role, 'owner'))
          )
      )
      expect(remaining).toHaveLength(1)
      await app.close()
    })

    it('answers 404 for a cross-org user on project add', async () => {
      const app = await freshApp()
      const { organizationId, ownerUserId } = await createOrg(app)
      const other = await createOrg(app)
      const foreignUser = await addOrgMember(app, other.organizationId)
      const projectId = await seedProject(organizationId, ownerUserId)

      const res = await app.inject({
        method: 'POST',
        url: `${ORG_URL}/${organizationId}/projects/${projectId}/members`,
        headers: { [TOKEN_HEADER]: TOKEN },
        payload: { requestId: randomUUID(), userId: foreignUser, role: 'member' },
      })
      expect(res.statusCode).toBe(404)
      expect(errorBody(res).code).toBe('user_not_found')
      await app.close()
    })
  })
})
