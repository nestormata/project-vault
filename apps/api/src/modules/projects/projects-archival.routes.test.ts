import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { extensionLifecycleEvents, projects } from '@project-vault/db/schema'
import type { ExtensionHooks, ExtensionManifest } from '@project-vault/extension-api'
import {
  __resetExtensionStateForTests,
  __setExtensionStateForTests,
} from '../../extensions/loader.js'
import { AuditEvent } from '@project-vault/shared'
import { archiveAuditRowsFor } from '../../__tests__/helpers/archive-audit-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import { createMembershipTestHelpers } from '../../__tests__/helpers/membership-test-helpers.js'
import {
  assertRoutesFailClosedWhileSealed,
  bootstrapRouteIntegrationTest,
  cookieHeader,
  type CookieJar,
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
  PROJECT_ROUTE_TEST_VAULT_SECRET,
} from './project-route-test-bootstrap.js'

const { createApp, initVault, humanAudit } = await bootstrapRouteIntegrationTest()
type TestApp = Awaited<ReturnType<typeof createApp>>

const TEST_PASSPHRASE = PROJECT_ROUTE_TEST_VAULT_SECRET
const PROJECTS_URL = '/api/v1/projects'
const FORCED_AUDIT_FAILURE = 'forced audit failure'

const { registerOwner, addUserToOrg, addProjectMember, projectRoleOf } =
  createMembershipTestHelpers({
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

// Story 35.1 AC2 — asserts the `extension_lifecycle_events` row(s) for one project, scoped by org
// (RLS-respecting withOrg, matching this file's own currentArchivedAt convention).
async function extensionLifecycleEventsFor(orgId: string, projectId: string) {
  return withOrg(orgId, (tx) =>
    tx
      .select()
      .from(extensionLifecycleEvents)
      .where(eq(extensionLifecycleEvents.projectId, projectId))
  )
}

describe('project archival routes (4.4)', () => {
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

      // Story 35.1 AC2 — exactly one pending extension_lifecycle_events row, scoped to the
      // archiving org, inserted in the same transaction as the archivedAt UPDATE.
      const events = await extensionLifecycleEventsFor(owner.orgId, projectId)
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        orgId: owner.orgId,
        projectId,
        eventType: 'project_archived',
        status: 'pending',
        attemptCount: 0,
        deliveredAt: null,
      })
      expect(events[0]?.payload).toMatchObject({
        organizationId: owner.orgId,
        projectId,
        archivedByUserId: owner.userId,
      })
      expect(typeof (events[0]?.payload as { archivedAt?: unknown })?.archivedAt).toBe('string')

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

    it('archives a project with no rotations (active-rotation guard finds nothing to block on)', async () => {
      // The rotation-blocking behavior itself (in_progress/stale_recovery rows blocking, other
      // statuses not blocking) is unit-tested directly against findBlockingRotationIds in
      // archive-guards.test.ts. This test documents the API-level baseline: a project with zero
      // rotation rows archives cleanly.
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
        // Story 35.1 AC2 edge case — the audit write's own fail-closed path rolls back the WHOLE
        // transaction, so no extension_lifecycle_events row is left behind either.
        expect(await extensionLifecycleEventsFor(owner.orgId, projectId)).toHaveLength(0)
      } finally {
        auditSpy.mockRestore()
      }
    })

    it('409 already_archived double-archive race inserts exactly one extension_lifecycle_events row, not two (AC2)', async () => {
      const owner = await registerOwner(app, 'archive-race-events')
      const projectId = await createProject(app, owner.cookies, 'archive-race-events')

      const first = await archiveProject(app, owner.cookies, projectId)
      expect(first.statusCode).toBe(200)
      const second = await archiveProject(app, owner.cookies, projectId)
      expect(second.statusCode).toBe(409)

      const events = await extensionLifecycleEventsFor(owner.orgId, projectId)
      expect(events).toHaveLength(1)
    })

    // Story 35.1 Task 5/AC5 — proves the archive route's own response time/status is unaffected
    // by a never-resolving projectArchiveNotifier hook. Structural, not just timing-based: the
    // route only ever inserts the outbox row (Task 3) — it never imports, references, or awaits
    // `projectArchiveNotifier` at all, so a hanging hook has no code path in the request handler
    // that could ever observe it. A loaded extension whose hook never resolves is set up here
    // purely to prove that a real, "worse case" hook is still never reached synchronously.
    it('archive route response is unaffected by a never-resolving projectArchiveNotifier hook (AC5)', async () => {
      const onProjectArchived = vi.fn(() => new Promise<void>(() => undefined))
      const manifest: ExtensionManifest = {
        name: 'com.acme.archive-notify-hang',
        apiVersion: '1.5.0',
        capabilities: ['project-archive-notify'],
      }
      const hooks: ExtensionHooks = { projectArchiveNotifier: { onProjectArchived } }
      __setExtensionStateForTests({
        status: 'loaded',
        manifest,
        loadedAt: new Date().toISOString(),
        hooks,
      })

      try {
        const owner = await registerOwner(app, 'archive-hang-isolated')
        const projectId = await createProject(app, owner.cookies, 'archive-hang-isolated')

        // Story 66-17 (DW-434 family): no elapsed-time ceiling. The request never awaits the hook
        // at all (it is never even called), so it answers 200 in ordinary request-handling time;
        // had it awaited the never-resolving hook it would never answer and this test would hit
        // its own timeout.
        const res = await archiveProject(app, owner.cookies, projectId)

        expect(res.statusCode).toBe(200)
        expect(onProjectArchived).not.toHaveBeenCalled()

        const events = await extensionLifecycleEventsFor(owner.orgId, projectId)
        expect(events).toHaveLength(1)
        expect(events[0]?.status).toBe('pending')
      } finally {
        __resetExtensionStateForTests()
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

  // Story 69.20 (DW-618): the org floor is `member`; archiveAuthority() (project owner row OR org
  // owner) decides. The web controls call the same rule.
  describe('archive authority by role (69.20)', () => {
    type Setup = { orgId: string; projectId: string; ownerCookies: CookieJar }

    async function projectOwnedByOrgOwner(label: string): Promise<Setup> {
      const owner = await registerOwner(app, label)
      const projectId = await createProject(app, owner.cookies, label)
      return { orgId: owner.orgId, projectId, ownerCookies: owner.cookies }
    }

    async function callerWith(
      setup: Setup,
      label: string,
      orgRole: string,
      projectRole: string | null
    ) {
      const caller = await addUserToOrg(app, setup.orgId, label, { orgRole })
      if (projectRole)
        await addProjectMember(setup.orgId, setup.projectId, caller.userId, projectRole)
      return caller
    }

    it('an org member who created (and so owns) the project archives and unarchives it, audited as project_owner', async () => {
      const owner = await registerOwner(app, 'member-owner')
      const member = await addUserToOrg(app, owner.orgId, 'member-owner-caller', {
        orgRole: 'member',
      })
      const projectId = await createProject(app, member.cookies, 'member-owner')
      expect(await projectRoleOf(owner.orgId, projectId, member.userId)).toBe('owner')

      const archived = await archiveProject(app, member.cookies, projectId)
      expect(archived.statusCode).toBe(200)
      expect(await currentArchivedAt(owner.orgId, projectId)).not.toBeNull()
      expect(
        await archiveAuditRowsFor(owner.orgId, AuditEvent.PROJECT_ARCHIVED, projectId)
      ).toEqual([{ actorUserId: member.userId, payload: { authorizedVia: 'project_owner' } }])

      const restored = await unarchiveProject(app, member.cookies, projectId)
      expect(restored.statusCode).toBe(200)
      expect(await currentArchivedAt(owner.orgId, projectId)).toBeNull()
      expect(
        await archiveAuditRowsFor(owner.orgId, AuditEvent.PROJECT_UNARCHIVED, projectId)
      ).toEqual([{ actorUserId: member.userId, payload: { authorizedVia: 'project_owner' } }])
    })

    it('an org admin holding the owner row archives (project_owner)', async () => {
      const setup = await projectOwnedByOrgOwner('admin-owner-row')
      const admin = await callerWith(setup, 'admin-owner-row-caller', 'admin', 'owner')

      const res = await archiveProject(app, admin.cookies, setup.projectId)
      expect(res.statusCode).toBe(200)
      expect(
        await archiveAuditRowsFor(setup.orgId, AuditEvent.PROJECT_ARCHIVED, setup.projectId)
      ).toEqual([{ actorUserId: admin.userId, payload: { authorizedVia: 'project_owner' } }])
    })

    it('an org owner without a row archives (org_owner)', async () => {
      const setup = await projectOwnedByOrgOwner('org-owner-no-row')
      const orgOwner = await callerWith(setup, 'org-owner-no-row-caller', 'owner', null)

      const res = await archiveProject(app, orgOwner.cookies, setup.projectId)
      expect(res.statusCode).toBe(200)
      expect(
        await archiveAuditRowsFor(setup.orgId, AuditEvent.PROJECT_ARCHIVED, setup.projectId)
      ).toEqual([{ actorUserId: orgOwner.userId, payload: { authorizedVia: 'org_owner' } }])
    })

    it.each([
      ['an org member with a project admin row', 'member', 'admin', 403, 'insufficient_role'],
      ['an org member with a project member row', 'member', 'member', 403, 'insufficient_role'],
      [
        'an org member with a project viewer row',
        'member',
        'viewer',
        403,
        'insufficient_project_role',
      ],
      ['an org member with no project row', 'member', null, 404, 'project_not_found'],
      ['an org admin with a project admin row', 'admin', 'admin', 403, 'insufficient_role'],
      ['an org admin with no project row', 'admin', null, 403, 'insufficient_role'],
      ['an org viewer holding an owner row', 'viewer', 'owner', 403, 'insufficient_role'],
    ])(
      '%s is refused on archive and unarchive and nothing changes',
      async (_label, orgRole, projectRole, status, code) => {
        const setup = await projectOwnedByOrgOwner(`refused-${orgRole}-${projectRole ?? 'none'}`)
        const caller = await callerWith(setup, `refused-${orgRole}-caller`, orgRole, projectRole)

        const archive = await archiveProject(app, caller.cookies, setup.projectId)
        expect(archive.statusCode).toBe(status)
        expect(archive.json()).toMatchObject({ code })
        expect(await currentArchivedAt(setup.orgId, setup.projectId)).toBeNull()

        expect((await archiveProject(app, setup.ownerCookies, setup.projectId)).statusCode).toBe(
          200
        )
        const unarchive = await unarchiveProject(app, caller.cookies, setup.projectId)
        expect(unarchive.statusCode).toBe(status)
        expect(unarchive.json()).toMatchObject({ code })
        expect(await currentArchivedAt(setup.orgId, setup.projectId)).not.toBeNull()
        expect(
          await archiveAuditRowsFor(setup.orgId, AuditEvent.PROJECT_UNARCHIVED, setup.projectId)
        ).toEqual([])
      }
    )

    it("an org member who owns a project in their own org gets 404 for another org's project", async () => {
      const owner = await registerOwner(app, 'member-owner-cross')
      const member = await addUserToOrg(app, owner.orgId, 'member-owner-cross-caller', {
        orgRole: 'member',
      })
      await createProject(app, member.cookies, 'member-owner-cross-own')
      const foreign = await projectOwnedByOrgOwner('member-owner-cross-foreign')

      const res = await archiveProject(app, member.cookies, foreign.projectId)
      expect(res.statusCode).toBe(404)
      expect(res.json()).toMatchObject({ code: 'project_not_found' })
      expect(await currentArchivedAt(foreign.orgId, foreign.projectId)).toBeNull()
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
