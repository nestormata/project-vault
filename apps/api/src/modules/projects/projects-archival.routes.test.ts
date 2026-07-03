import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { projects } from '@project-vault/db/schema'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import { createMembershipTestHelpers } from '../../__tests__/helpers/membership-test-helpers.js'
import {
  assertRoutesFailClosedWhileSealed,
  bootstrapRouteIntegrationTest,
  cookieHeader,
  createProjectViaApi as createProject,
  expectAuditWriteFailed,
  initVaultForTest,
} from '../../__tests__/helpers/auth-test-helpers.js'
import {
  createCredentialTestProject,
  createCredentialViaApi,
} from '../credentials/credential-route-test-helpers.js'
import {
  bootProjectRouteTestApp,
  PROJECT_ROUTE_TEST_PASSPHRASE,
} from './project-route-test-bootstrap.js'

const { createApp, initVault, humanAudit } = await bootstrapRouteIntegrationTest()
type TestApp = Awaited<ReturnType<typeof createApp>>

const TEST_PASSPHRASE = PROJECT_ROUTE_TEST_PASSPHRASE
const PROJECTS_URL = '/api/v1/projects'
const FORCED_AUDIT_FAILURE = 'forced audit failure'

const { registerOwner, addUserToOrg } = createMembershipTestHelpers({
  emailPrefix: 'archival',
  orgNamePrefix: 'Archival',
})

function archiveUrl(projectId: string): string {
  return `${PROJECTS_URL}/${projectId}/archive`
}

function unarchiveUrl(projectId: string): string {
  return `${PROJECTS_URL}/${projectId}/unarchive`
}

function archiveProject(app: TestApp, cookies: Record<string, string>, projectId: string) {
  return app.inject({
    method: 'POST',
    url: archiveUrl(projectId),
    headers: { cookie: cookieHeader(cookies) },
  })
}

function unarchiveProject(app: TestApp, cookies: Record<string, string>, projectId: string) {
  return app.inject({
    method: 'POST',
    url: unarchiveUrl(projectId),
    headers: { cookie: cookieHeader(cookies) },
  })
}

function listProjects(
  app: TestApp,
  cookies: Record<string, string>,
  query = ''
): Promise<{ statusCode: number; json: <T>() => T }> {
  return app.inject({
    method: 'GET',
    url: `${PROJECTS_URL}${query}`,
    headers: { cookie: cookieHeader(cookies) },
  })
}

/** Shared by the archive/unarchive audit-failure tests to assert the DB row after rollback. */
async function currentArchivedAt(orgId: string, projectId: string): Promise<Date | null> {
  const rows = await withOrg(orgId, (tx) =>
    tx.select({ archivedAt: projects.archivedAt }).from(projects).where(eq(projects.id, projectId))
  )
  return rows[0]?.archivedAt ?? null
}

describe.sequential('project archival routes (4.4)', () => {
  let app: TestApp

  beforeAll(async () => {
    app = await bootProjectRouteTestApp(createApp, initVault)
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  describe('POST /:projectId/archive', () => {
    it('archives a clean project and hides/reveals it in the project list (AC-2, AC-3)', async () => {
      const owner = await registerOwner(app, 'archive-clean')
      const projectId = await createProject(app, owner.cookies, 'archive-clean')

      const res = await archiveProject(app, owner.cookies, projectId)
      expect(res.statusCode).toBe(200)
      const body = res.json<{
        data: { id: string; name: string; slug: string; archivedAt: string; isArchived: boolean }
      }>()
      expect(body.data.id).toBe(projectId)
      expect(body.data.isArchived).toBe(true)
      expect(new Date(body.data.archivedAt).toISOString()).toBe(body.data.archivedAt)

      const defaultList = await listProjects(app, owner.cookies)
      expect(defaultList.statusCode).toBe(200)
      expect(
        defaultList
          .json<{ data: { items: { id: string }[] } }>()
          .data.items.some((item) => item.id === projectId)
      ).toBe(false)

      const includeArchivedList = await listProjects(app, owner.cookies, '?includeArchived=true')
      expect(includeArchivedList.statusCode).toBe(200)
      const archivedItem = includeArchivedList
        .json<{
          data: { items: { id: string; archivedAt: string | null; isArchived: boolean }[] }
        }>()
        .data.items.find((item) => item.id === projectId)
      expect(archivedItem).toMatchObject({ isArchived: true })
      expect(archivedItem?.archivedAt).not.toBeNull()

      const explicitFalseList = await listProjects(app, owner.cookies, '?includeArchived=false')
      expect(explicitFalseList.statusCode).toBe(200)
      expect(
        explicitFalseList
          .json<{ data: { items: { id: string }[] } }>()
          .data.items.some((item) => item.id === projectId)
      ).toBe(false)
    })

    it('returns [] from the active-rotation guard because the `rotations` table (Epic 5) does not exist yet (ADR-4.4-02)', async () => {
      // Story 5.1 hasn't shipped in this environment, so there is no rotations table to seed a
      // blocking row against. The table-existence seam itself is unit-tested directly in
      // archive-guards.test.ts (including the CI guard that fails once the table appears but the
      // seam is still present). This test documents the API-level consequence: archival is never
      // blocked by rotations while the table is absent.
      const owner = await registerOwner(app, 'archive-no-rotations-table')
      const projectId = await createProject(app, owner.cookies, 'archive-no-rotations')

      const res = await archiveProject(app, owner.cookies, projectId)
      expect(res.statusCode).toBe(200)
    })

    it('409 already_archived on double-archive', async () => {
      const owner = await registerOwner(app, 'double-archive')
      const projectId = await createProject(app, owner.cookies, 'double-archive')

      const first = await archiveProject(app, owner.cookies, projectId)
      expect(first.statusCode).toBe(200)

      const second = await archiveProject(app, owner.cookies, projectId)
      expect(second.statusCode).toBe(409)
      expect(second.json()).toMatchObject({ code: 'already_archived' })
    })

    it('403 insufficient_role when caller is a project member, not owner', async () => {
      const owner = await registerOwner(app, 'archive-non-owner')
      const projectId = await createProject(app, owner.cookies, 'archive-non-owner')
      const member = await addUserToOrg(app, owner.orgId, 'archive-non-owner-member', {
        orgRole: 'admin',
      })

      const res = await archiveProject(app, member.cookies, projectId)
      expect(res.statusCode).toBe(403)
      expect(res.json()).toMatchObject({ code: 'insufficient_role' })

      const stillActive = await withOrg(owner.orgId, (tx) =>
        tx
          .select({ archivedAt: projects.archivedAt })
          .from(projects)
          .where(eq(projects.id, projectId))
      )
      expect(stillActive[0]?.archivedAt).toBeNull()
    })

    it('404 when projectId does not exist and 404 (not 403) cross-org', async () => {
      const owner = await registerOwner(app, 'archive-404')
      const otherOwner = await registerOwner(app, 'archive-404-other')
      const otherProjectId = await createProject(app, otherOwner.cookies, 'archive-404-other-proj')

      const missing = await archiveProject(app, owner.cookies, randomUUID())
      expect(missing.statusCode).toBe(404)
      expect(missing.json()).toMatchObject({ code: 'project_not_found' })

      const crossOrg = await archiveProject(app, owner.cookies, otherProjectId)
      expect(crossOrg.statusCode).toBe(404)
      expect(crossOrg.json()).toMatchObject({ code: 'project_not_found' })
    })

    it('422 when projectId is not a UUID', async () => {
      const owner = await registerOwner(app, 'archive-422')
      const res = await archiveProject(app, owner.cookies, 'not-a-uuid')
      expect(res.statusCode).toBe(422)
    })

    it('401 when unauthenticated', async () => {
      const res = await app.inject({ method: 'POST', url: archiveUrl(randomUUID()) })
      expect(res.statusCode).toBe(401)
    })

    it('403 mfa_required when caller has no MFA enrollment and no active grace period', async () => {
      const { registerAndLoginViaApi } =
        await import('../../__tests__/helpers/auth-test-helpers.js')
      const { withOrg: withOrgFn } = await import('@project-vault/db')
      const { orgMemberships } = await import('@project-vault/db/schema')
      const { and, eq: eqOp } = await import('drizzle-orm')

      const unenrolledOwner = await registerAndLoginViaApi(app, {
        email: `archival-mfa-${randomUUID()}@example.com`,
        password: 'correct-horse-battery-staple',
        orgName: `Archival MFA ${randomUUID()}`,
      })
      const projectId = await createProject(app, unenrolledOwner.cookies, 'archive-mfa')
      // registerAndLoginViaApi grants an owner MFA grace period — expire it directly to exercise
      // the enforced branch of requireMfaEnrollment(), same pattern as Story 4.3's test.
      await withOrgFn(unenrolledOwner.orgId, (tx) =>
        tx
          .update(orgMemberships)
          .set({ gracePeriodExpiresAt: new Date(Date.now() - 1000) })
          .where(
            and(
              eqOp(orgMemberships.orgId, unenrolledOwner.orgId),
              eqOp(orgMemberships.userId, unenrolledOwner.userId)
            )
          )
      )

      const res = await archiveProject(app, unenrolledOwner.cookies, projectId)
      expect(res.statusCode).toBe(403)
      expect(res.json()).toMatchObject({ code: 'mfa_required' })
    })

    it('rolls back and returns 503 audit_write_failed when the project.archived audit write fails', async () => {
      const owner = await registerOwner(app, 'archive-audit-fail')
      const projectId = await createProject(app, owner.cookies, 'archive-audit-fail')

      const auditSpy = vi
        .spyOn(humanAudit, 'writeHumanAuditEntry')
        .mockRejectedValueOnce(new Error(FORCED_AUDIT_FAILURE))
      try {
        const res = await archiveProject(app, owner.cookies, projectId)
        expectAuditWriteFailed(res)
        expect(await currentArchivedAt(owner.orgId, projectId)).toBeNull()
      } finally {
        auditSpy.mockRestore()
      }
    })
  })

  describe('POST /:projectId/unarchive', () => {
    it('restores an archived project (AC-6) and it reappears in the default list', async () => {
      const owner = await registerOwner(app, 'unarchive-clean')
      const projectId = await createProject(app, owner.cookies, 'unarchive-clean')
      const archived = await archiveProject(app, owner.cookies, projectId)
      expect(archived.statusCode).toBe(200)

      const res = await unarchiveProject(app, owner.cookies, projectId)
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({
        data: { id: projectId, archivedAt: null, isArchived: false },
      })

      const defaultList = await listProjects(app, owner.cookies)
      expect(
        defaultList
          .json<{ data: { items: { id: string }[] } }>()
          .data.items.some((item) => item.id === projectId)
      ).toBe(true)
    })

    it('409 not_archived when the project is already active', async () => {
      const owner = await registerOwner(app, 'unarchive-not-archived')
      const projectId = await createProject(app, owner.cookies, 'unarchive-not-archived')

      const res = await unarchiveProject(app, owner.cookies, projectId)
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ code: 'not_archived' })
    })

    it('403 when caller is not the owner', async () => {
      const owner = await registerOwner(app, 'unarchive-non-owner')
      const projectId = await createProject(app, owner.cookies, 'unarchive-non-owner')
      await archiveProject(app, owner.cookies, projectId)
      const member = await addUserToOrg(app, owner.orgId, 'unarchive-non-owner-member', {
        orgRole: 'admin',
      })

      const res = await unarchiveProject(app, member.cookies, projectId)
      expect(res.statusCode).toBe(403)
    })

    it('404 cross-org / not found', async () => {
      const owner = await registerOwner(app, 'unarchive-404')
      const otherOwner = await registerOwner(app, 'unarchive-404-other')
      const otherProjectId = await createProject(
        app,
        otherOwner.cookies,
        'unarchive-404-other-proj'
      )
      await archiveProject(app, otherOwner.cookies, otherProjectId)

      const crossOrg = await unarchiveProject(app, owner.cookies, otherProjectId)
      expect(crossOrg.statusCode).toBe(404)

      const missing = await unarchiveProject(app, owner.cookies, randomUUID())
      expect(missing.statusCode).toBe(404)
    })

    it('rolls back and returns 503 audit_write_failed when the project.unarchived audit write fails', async () => {
      const owner = await registerOwner(app, 'unarchive-audit-fail')
      const projectId = await createProject(app, owner.cookies, 'unarchive-audit-fail')
      await archiveProject(app, owner.cookies, projectId)

      const auditSpy = vi
        .spyOn(humanAudit, 'writeHumanAuditEntry')
        .mockRejectedValueOnce(new Error(FORCED_AUDIT_FAILURE))
      try {
        const res = await unarchiveProject(app, owner.cookies, projectId)
        expectAuditWriteFailed(res)
        expect(await currentArchivedAt(owner.orgId, projectId)).not.toBeNull()
      } finally {
        auditSpy.mockRestore()
      }
    })
  })

  describe('write guard: archived projects reject mutations with 410 (AC-5)', () => {
    it('410 project_archived on PATCH metadata; GET reads still succeed', async () => {
      const owner = await registerOwner(app, 'guard-patch')
      const projectId = await createProject(app, owner.cookies, 'guard-patch')
      await archiveProject(app, owner.cookies, projectId)

      const patch = await app.inject({
        method: 'PATCH',
        url: `${PROJECTS_URL}/${projectId}`,
        headers: { cookie: cookieHeader(owner.cookies) },
        payload: { name: 'Should not update' },
      })
      expect(patch.statusCode).toBe(410)
      expect(patch.json()).toMatchObject({ code: 'project_archived' })

      const dashboard = await app.inject({
        method: 'GET',
        url: `${PROJECTS_URL}/${projectId}/dashboard`,
        headers: { cookie: cookieHeader(owner.cookies) },
      })
      expect(dashboard.statusCode).toBe(200)
    })

    it('410 project_archived on PUT project tags', async () => {
      const owner = await registerOwner(app, 'guard-tags')
      const projectId = await createProject(app, owner.cookies, 'guard-tags')
      await archiveProject(app, owner.cookies, projectId)

      const res = await app.inject({
        method: 'PUT',
        url: `${PROJECTS_URL}/${projectId}/tags`,
        headers: { cookie: cookieHeader(owner.cookies) },
        payload: { tags: ['blocked'] },
      })
      expect(res.statusCode).toBe(410)
      expect(res.json()).toMatchObject({ code: 'project_archived' })
    })

    it('410 project_archived on POST credential creation for an archived project', async () => {
      const owner = await registerOwner(app, 'guard-credential-create')
      const projectId = await createCredentialTestProject(app, owner.cookies, 'guard-cred-create')
      await archiveProject(app, owner.cookies, projectId)

      const res = await app.inject({
        method: 'POST',
        url: `${PROJECTS_URL}/${projectId}/credentials`,
        headers: { cookie: cookieHeader(owner.cookies) },
        payload: { name: 'Blocked Key', value: 'blocked' },
      })
      expect(res.statusCode).toBe(410)
      expect(res.json()).toMatchObject({ code: 'project_archived' })
    })

    it('410 project_archived on POST credential version creation for an archived project', async () => {
      const owner = await registerOwner(app, 'guard-credential-version')
      const projectId = await createCredentialTestProject(app, owner.cookies, 'guard-cred-version')
      const credential = await createCredentialViaApi(app, owner.cookies, projectId, {
        name: 'Rotatable Key',
        value: 'initial',
      })
      await archiveProject(app, owner.cookies, projectId)

      const res = await app.inject({
        method: 'POST',
        url: `${PROJECTS_URL}/${projectId}/credentials/${credential.id}/versions`,
        headers: { cookie: cookieHeader(owner.cookies) },
        payload: { value: 'rotated' },
      })
      expect(res.statusCode).toBe(410)
      expect(res.json()).toMatchObject({ code: 'project_archived' })
    })

    it('410 project_archived on transfer-ownership for an archived project', async () => {
      const owner = await registerOwner(app, 'guard-transfer')
      const projectId = await createProject(app, owner.cookies, 'guard-transfer')
      const other = await addUserToOrg(app, owner.orgId, 'guard-transfer-other')
      await withOrg(owner.orgId, async (tx) => {
        const { projectMemberships } = await import('@project-vault/db/schema')
        await tx
          .insert(projectMemberships)
          .values({ orgId: owner.orgId, projectId, userId: other.userId, role: 'admin' })
      })
      await archiveProject(app, owner.cookies, projectId)

      const res = await app.inject({
        method: 'POST',
        url: `${PROJECTS_URL}/${projectId}/transfer-ownership`,
        headers: { cookie: cookieHeader(owner.cookies) },
        payload: { newOwnerId: other.userId },
      })
      expect(res.statusCode).toBe(410)
      expect(res.json()).toMatchObject({ code: 'project_archived' })
    })
  })

  describe('sealed vault (AC-12)', () => {
    it('503 { status: "sealed" } for archive and unarchive when the vault is sealed', async () => {
      const owner = await registerOwner(app, 'sealed-setup')
      const projectId = await createProject(app, owner.cookies, 'sealed-setup')

      app = await assertRoutesFailClosedWhileSealed(
        app,
        () => createApp({ logger: false, vaultGuardEnabled: true }),
        [
          { method: 'POST', url: archiveUrl(projectId) },
          { method: 'POST', url: unarchiveUrl(projectId) },
        ]
      )

      await app.close()
      await initVaultForTest(initVault, TEST_PASSPHRASE)
      app = await createApp({ logger: false, vaultGuardEnabled: true })
    })
  })
})
