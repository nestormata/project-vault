import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import {
  credentials,
  credentialShares,
  machineUsers,
  projectInvitations,
  projects,
  serviceEndpoints,
} from '@project-vault/db/schema'
import { AuditEvent } from '@project-vault/shared'
import { archiveAuditRowsFor } from '../../__tests__/helpers/archive-audit-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import { createMembershipTestHelpers } from '../../__tests__/helpers/membership-test-helpers.js'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  createProjectViaApi as createProject,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { createCredentialViaApi } from '../credentials/credential-route-test-helpers.js'
import { runProjectPurgeJob } from '../../workers/project-purge.js'
import { preflightCredentialForShareCreation } from '../credential-shares/service.js'
import { PROJECT_DELETE_GRACE_DAYS } from './project-lifecycle.js'
import { bootProjectRouteTestApp } from './project-route-test-bootstrap.js'

const { createApp, initVault } = await bootstrapRouteIntegrationTest()
type TestApp = Awaited<ReturnType<typeof createApp>>
type Cookies = Record<string, string>

const PROJECTS_URL = '/api/v1/projects'
const DAY_MS = 86_400_000

const { registerOwner, addUserToOrg, addProjectMember } = createMembershipTestHelpers({
  emailPrefix: 'softdel',
  orgNamePrefix: 'SoftDel',
})

function call(
  app: TestApp,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  cookies: Cookies,
  payload?: object
) {
  return app.inject({
    method,
    url: `${PROJECTS_URL}${url}`,
    headers: { cookie: cookieHeader(cookies) },
    ...(payload ? { payload } : {}),
  })
}

async function projectRow(orgId: string, projectId: string) {
  const [row] = await withOrg(orgId, (tx) =>
    tx.select().from(projects).where(eq(projects.id, projectId))
  )
  return row
}

async function makeProjectOwnerWhoIsNotOrgOwner(
  app: TestApp,
  orgId: string,
  projectId: string,
  label: string
) {
  const user = await addUserToOrg(app, orgId, label, { orgRole: 'member' })
  await addProjectMember(orgId, projectId, user.userId, 'owner')
  return user
}

describe('project edit, soft delete and restore (72-9)', () => {
  let app: TestApp

  beforeAll(async () => {
    app = await bootProjectRouteTestApp(createApp, initVault)
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  describe('PATCH /:projectId (name, description, urls)', () => {
    it('updates urls, returns them, and audits the changed field names only', async () => {
      const owner = await registerOwner(app, 'patch-urls')
      const projectId = await createProject(app, owner.cookies, 'patch-urls')

      const res = await call(app, 'PATCH', `/${projectId}`, owner.cookies, {
        name: 'Renamed',
        urls: ['https://example.com/wiki', ' http://intranet.example.org '],
      })
      expect(res.statusCode).toBe(200)
      expect(res.json<{ data: { name: string; urls: string[] } }>().data).toMatchObject({
        name: 'Renamed',
        urls: ['https://example.com/wiki', 'http://intranet.example.org/'],
      })

      const overview = await call(app, 'GET', `/${projectId}`, owner.cookies)
      expect(overview.json<{ data: { urls: string[] } }>().data.urls).toHaveLength(2)

      const audit = await archiveAuditRowsFor(owner.orgId, AuditEvent.PROJECT_UPDATED, projectId)
      expect(audit).toHaveLength(1)
      expect(audit[0]?.payload).toEqual({
        authorizedVia: 'project_owner',
        changedFields: ['name', 'urls'],
      })

      const cleared = await call(app, 'PATCH', `/${projectId}`, owner.cookies, { urls: [] })
      expect(cleared.json<{ data: { urls: string[] } }>().data.urls).toEqual([])
    })

    it.each([
      ['javascript scheme', ['javascript:alert(1)']],
      ['credentials in the URL', ['https://u:p@example.com']],
      ['duplicates', ['https://example.com', 'https://EXAMPLE.com']],
      ['too many', Array.from({ length: 11 }, (_, i) => `https://example.com/${i}`)],
    ])('422 for %s', async (_label, urls) => {
      const owner = await registerOwner(app, 'patch-bad-urls')
      const projectId = await createProject(app, owner.cookies, 'patch-bad-urls')
      const res = await call(app, 'PATCH', `/${projectId}`, owner.cookies, { urls })
      expect(res.statusCode).toBe(422)
    })

    it('403 for an org admin and for a project member who does not own the project', async () => {
      const owner = await registerOwner(app, 'patch-403')
      const projectId = await createProject(app, owner.cookies, 'patch-403')
      const admin = await addUserToOrg(app, owner.orgId, 'patch-403-admin', { orgRole: 'admin' })
      const member = await addUserToOrg(app, owner.orgId, 'patch-403-member', { orgRole: 'member' })
      await addProjectMember(owner.orgId, projectId, member.userId, 'member')

      for (const caller of [admin, member]) {
        const res = await call(app, 'PATCH', `/${projectId}`, caller.cookies, { name: 'Nope' })
        expect(res.statusCode).toBe(403)
      }
      expect((await projectRow(owner.orgId, projectId))?.name).not.toBe('Nope')
    })

    it('a project owner who is only an org member can edit', async () => {
      const owner = await registerOwner(app, 'patch-pown')
      const projectId = await createProject(app, owner.cookies, 'patch-pown')
      const projectOwner = await makeProjectOwnerWhoIsNotOrgOwner(
        app,
        owner.orgId,
        projectId,
        'patch-pown-user'
      )

      const res = await call(app, 'PATCH', `/${projectId}`, projectOwner.cookies, {
        description: 'by project owner',
      })
      expect(res.statusCode).toBe(200)
      const audit = await archiveAuditRowsFor(owner.orgId, AuditEvent.PROJECT_UPDATED, projectId)
      expect(audit[0]?.payload).toMatchObject({ authorizedVia: 'project_owner' })
    })

    it('answers the authorization failure before validating the body', async () => {
      const owner = await registerOwner(app, 'patch-order')
      const projectId = await createProject(app, owner.cookies, 'patch-order')
      const admin = await addUserToOrg(app, owner.orgId, 'patch-order-admin', { orgRole: 'admin' })
      const res = await call(app, 'PATCH', `/${projectId}`, admin.cookies, {
        urls: ['javascript:x'],
      })
      expect(res.statusCode).toBe(403)
    })

    it('410 on an archived project and 404 on a missing one', async () => {
      const owner = await registerOwner(app, 'patch-410')
      const projectId = await createProject(app, owner.cookies, 'patch-410')
      await call(app, 'POST', `/${projectId}/archive`, owner.cookies)
      expect(
        (await call(app, 'PATCH', `/${projectId}`, owner.cookies, { name: 'x' })).statusCode
      ).toBe(410)
      expect(
        (await call(app, 'PATCH', `/${randomUUID()}`, owner.cookies, { name: 'x' })).statusCode
      ).toBe(404)
    })
  })

  describe('DELETE /:projectId and POST /:projectId/restore', () => {
    it('soft deletes: hides the project everywhere, revokes shares with audit, sets the purge date', async () => {
      const owner = await registerOwner(app, 'del-main')
      const projectId = await createProject(app, owner.cookies, 'del-main')
      const credential = await createCredentialViaApi(app, owner.cookies, projectId)
      const recipient = await addUserToOrg(app, owner.orgId, 'del-main-recipient', {
        orgRole: 'member',
      })
      const shareId = randomUUID()
      await withOrg(owner.orgId, (tx) =>
        tx.insert(credentialShares).values({
          id: shareId,
          orgId: owner.orgId,
          credentialId: credential.id,
          sharedBy: owner.userId,
          recipientType: 'user',
          recipientUserId: recipient.userId,
          tokenHash: `hash-${shareId}`,
          expiresAt: new Date(Date.now() + DAY_MS),
        })
      )

      const before = Date.now()
      const res = await call(app, 'DELETE', `/${projectId}`, owner.cookies)
      expect(res.statusCode).toBe(200)
      const data = res.json<{
        data: { deletedAt: string; purgeAfter: string; revokedShareCount: number }
      }>().data
      expect(data.revokedShareCount).toBe(1)
      const purgeMs = new Date(data.purgeAfter).getTime() - new Date(data.deletedAt).getTime()
      expect(purgeMs).toBe(PROJECT_DELETE_GRACE_DAYS * DAY_MS)
      expect(new Date(data.deletedAt).getTime()).toBeGreaterThanOrEqual(before - 1000)

      const row = await projectRow(owner.orgId, projectId)
      expect(row?.deletedAt).not.toBeNull()
      expect(row?.archivedAt).not.toBeNull()
      expect(row?.deletedBy).toBe(owner.userId)

      // Hidden: overview, tabs under it, list (even with includeArchived) and a second delete.
      expect((await call(app, 'GET', `/${projectId}`, owner.cookies)).statusCode).toBe(404)
      expect((await call(app, 'GET', `/${projectId}/credentials`, owner.cookies)).statusCode).toBe(
        404
      )
      expect((await call(app, 'GET', `/${projectId}/members`, owner.cookies)).statusCode).toBe(404)
      expect(
        (await call(app, 'PATCH', `/${projectId}`, owner.cookies, { name: 'x' })).statusCode
      ).toBe(404)
      expect((await call(app, 'DELETE', `/${projectId}`, owner.cookies)).statusCode).toBe(404)
      const list = await call(app, 'GET', '?includeArchived=true', owner.cookies)
      expect(
        list.json<{ data: { items: { id: string }[] } }>().data.items.map((p) => p.id)
      ).not.toContain(projectId)

      // Shares revoked and audited with the reason; project.deleted carries the counts.
      const [share] = await withOrg(owner.orgId, (tx) =>
        tx.select().from(credentialShares).where(eq(credentialShares.id, shareId))
      )
      expect(share?.status).toBe('revoked')
      const shareAudit = await archiveAuditRowsFor(
        owner.orgId,
        AuditEvent.CREDENTIAL_SHARE_REVOKED,
        shareId
      )
      expect(shareAudit[0]?.payload).toMatchObject({
        reason: 'project_deleted',
        credentialId: credential.id,
      })
      const deleteAudit = await archiveAuditRowsFor(
        owner.orgId,
        AuditEvent.PROJECT_DELETED,
        projectId
      )
      expect(deleteAudit).toHaveLength(1)
      expect(deleteAudit[0]?.payload).toMatchObject({
        authorizedVia: 'project_owner',
        revokedShareCount: 1,
        wasArchived: false,
        purgeAfter: data.purgeAfter,
      })
    })

    it('409 while a machine user has an active API key, and nothing is deleted', async () => {
      const owner = await registerOwner(app, 'del-blocked')
      const projectId = await createProject(app, owner.cookies, 'del-blocked')
      const machineUser = await app.inject({
        method: 'POST',
        url: `${PROJECTS_URL}/${projectId}/machine-users`,
        headers: { cookie: cookieHeader(owner.cookies) },
        payload: { name: 'blocking-bot', role: 'member' },
      })
      const machineUserId = machineUser.json<{ data: { id: string } }>().data.id
      const key = await app.inject({
        method: 'POST',
        url: `/api/v1/machine-users/${machineUserId}/api-keys`,
        headers: { cookie: cookieHeader(owner.cookies) },
        payload: { name: 'blocking-key' },
      })
      expect(key.statusCode).toBe(201)

      const res = await call(app, 'DELETE', `/${projectId}`, owner.cookies)
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({
        error: 'active_machine_user_keys',
        machineUserIds: [machineUserId],
      })
      expect((await projectRow(owner.orgId, projectId))?.deletedAt).toBeNull()
    })

    it('an org owner who is not a project member can delete and restore, recorded as org_owner', async () => {
      const creator = await registerOwner(app, 'del-orgowner')
      const projectId = await createProject(app, creator.cookies, 'del-orgowner')
      const orgOwner = await addUserToOrg(app, creator.orgId, 'del-orgowner-second', {
        orgRole: 'owner',
      })
      expect((await call(app, 'DELETE', `/${projectId}`, orgOwner.cookies)).statusCode).toBe(200)
      const audit = await archiveAuditRowsFor(creator.orgId, AuditEvent.PROJECT_DELETED, projectId)
      expect(audit[0]?.payload).toMatchObject({ authorizedVia: 'org_owner' })
      expect((await call(app, 'POST', `/${projectId}/restore`, orgOwner.cookies)).statusCode).toBe(
        200
      )
    })

    it('403 for an org admin and a project member; the project is untouched', async () => {
      const owner = await registerOwner(app, 'del-403')
      const projectId = await createProject(app, owner.cookies, 'del-403')
      const admin = await addUserToOrg(app, owner.orgId, 'del-403-admin', { orgRole: 'admin' })
      const member = await addUserToOrg(app, owner.orgId, 'del-403-member', { orgRole: 'member' })
      await addProjectMember(owner.orgId, projectId, member.userId, 'member')
      for (const caller of [admin, member]) {
        const res = await call(app, 'DELETE', `/${projectId}`, caller.cookies)
        expect(res.statusCode).toBe(403)
        expect(res.json()).toMatchObject({ code: 'insufficient_role' })
      }
      expect((await projectRow(owner.orgId, projectId))?.deletedAt).toBeNull()
    })

    it("404 for a missing project and for another organization's project", async () => {
      const owner = await registerOwner(app, 'del-404')
      const other = await registerOwner(app, 'del-404-other')
      const otherProject = await createProject(app, other.cookies, 'del-404-other')
      expect((await call(app, 'DELETE', `/${randomUUID()}`, owner.cookies)).statusCode).toBe(404)
      expect((await call(app, 'DELETE', `/${otherProject}`, owner.cookies)).statusCode).toBe(404)
      expect((await call(app, 'POST', `/${otherProject}/restore`, owner.cookies)).statusCode).toBe(
        404
      )
    })

    it('a project owner who is only an org member can delete and restore', async () => {
      const owner = await registerOwner(app, 'del-pown')
      const projectId = await createProject(app, owner.cookies, 'del-pown')
      const projectOwner = await makeProjectOwnerWhoIsNotOrgOwner(
        app,
        owner.orgId,
        projectId,
        'del-pown-user'
      )
      expect((await call(app, 'DELETE', `/${projectId}`, projectOwner.cookies)).statusCode).toBe(
        200
      )

      const listed = await call(app, 'GET', '/deleted', projectOwner.cookies)
      expect(
        listed.json<{ data: { items: { id: string }[] } }>().data.items.map((p) => p.id)
      ).toEqual([projectId])
      expect(
        (await call(app, 'POST', `/${projectId}/restore`, projectOwner.cookies)).statusCode
      ).toBe(200)
      const audit = await archiveAuditRowsFor(owner.orgId, AuditEvent.PROJECT_RESTORED, projectId)
      expect(audit[0]?.payload).toEqual({ authorizedVia: 'project_owner' })
    })

    it('restore: comes back archived, keeps shares revoked, and is only for deleted projects', async () => {
      const owner = await registerOwner(app, 'del-restore')
      const projectId = await createProject(app, owner.cookies, 'del-restore')
      const admin = await addUserToOrg(app, owner.orgId, 'del-restore-admin', { orgRole: 'admin' })

      const notDeleted = await call(app, 'POST', `/${projectId}/restore`, owner.cookies)
      expect(notDeleted.statusCode).toBe(409)
      expect(notDeleted.json()).toMatchObject({ code: 'not_deleted' })

      await call(app, 'DELETE', `/${projectId}`, owner.cookies)
      expect((await call(app, 'POST', `/${projectId}/restore`, admin.cookies)).statusCode).toBe(403)

      const restored = await call(app, 'POST', `/${projectId}/restore`, owner.cookies)
      expect(restored.statusCode).toBe(200)
      expect(restored.json<{ data: { isArchived: boolean } }>().data.isArchived).toBe(true)
      const row = await projectRow(owner.orgId, projectId)
      expect(row).toMatchObject({ deletedAt: null, deletedBy: null, purgeAfter: null })
      expect(row?.archivedAt).not.toBeNull()

      // Visible again (read-only until unarchived), and gone from the deleted list.
      expect((await call(app, 'GET', `/${projectId}`, owner.cookies)).statusCode).toBe(200)
      expect(
        (await call(app, 'PATCH', `/${projectId}`, owner.cookies, { name: 'x' })).statusCode
      ).toBe(410)
      expect((await call(app, 'POST', `/${projectId}/unarchive`, owner.cookies)).statusCode).toBe(
        200
      )
      const listed = await call(app, 'GET', '/deleted', owner.cookies)
      expect(
        listed.json<{ data: { items: { id: string }[] } }>().data.items.map((p) => p.id)
      ).not.toContain(projectId)
    })

    it('deleting an archived project keeps its original archive time through a restore', async () => {
      const owner = await registerOwner(app, 'del-archived')
      const projectId = await createProject(app, owner.cookies, 'del-archived')
      await call(app, 'POST', `/${projectId}/archive`, owner.cookies)
      const archivedAt = (await projectRow(owner.orgId, projectId))?.archivedAt
      expect((await call(app, 'DELETE', `/${projectId}`, owner.cookies)).statusCode).toBe(200)
      const audit = await archiveAuditRowsFor(owner.orgId, AuditEvent.PROJECT_DELETED, projectId)
      expect(audit[0]?.payload).toMatchObject({ wasArchived: true })
      await call(app, 'POST', `/${projectId}/restore`, owner.cookies)
      expect((await projectRow(owner.orgId, projectId))?.archivedAt).toEqual(archivedAt)
    })

    it('GET /deleted lists nothing for a caller who owns no deleted project', async () => {
      const owner = await registerOwner(app, 'del-list')
      const projectId = await createProject(app, owner.cookies, 'del-list')
      await call(app, 'DELETE', `/${projectId}`, owner.cookies)
      const member = await addUserToOrg(app, owner.orgId, 'del-list-member', { orgRole: 'member' })
      const listed = await call(app, 'GET', '/deleted', member.cookies)
      expect(listed.statusCode).toBe(200)
      expect(listed.json<{ data: { items: unknown[] } }>().data.items).toEqual([])
    })
  })

  describe('review hardening (72-9)', () => {
    it('refuses new shares, flat machine-user reads and create replays for a deleted project', async () => {
      const label = 'del-hardening'
      const owner = await registerOwner(app, label)
      const projectId = await createProject(app, owner.cookies, label)
      const credential = await createCredentialViaApi(app, owner.cookies, projectId)
      const machineUser = await app.inject({
        method: 'POST',
        url: `${PROJECTS_URL}/${projectId}/machine-users`,
        headers: { cookie: cookieHeader(owner.cookies) },
        payload: { name: 'hardening-bot', role: 'member' },
      })
      const machineUserId = machineUser.json<{ data: { id: string } }>().data.id
      const detailUrl = `/api/v1/machine-users/${machineUserId}`
      const readDetail = () =>
        app.inject({
          method: 'GET',
          url: detailUrl,
          headers: { cookie: cookieHeader(owner.cookies) },
        })
      expect((await readDetail()).statusCode).toBe(200)

      const preflight = () =>
        withOrg(owner.orgId, (tx) =>
          preflightCredentialForShareCreation(tx, { credentialId: credential.id, projectId })
        )
      expect(await preflight()).toEqual({ status: 'ok' })

      await call(app, 'DELETE', `/${projectId}`, owner.cookies)

      expect(await preflight()).toEqual({ status: 'credential_not_found' })
      expect((await readDetail()).statusCode).toBe(404)
      const replay = await call(app, 'POST', '', owner.cookies, {
        name: label,
        creationRequestId: (await projectRow(owner.orgId, projectId))?.creationRequestId,
      })
      expect(replay.statusCode).toBeGreaterThanOrEqual(400)
      expect(replay.json()).toMatchObject({ code: 'creation_request_conflict' })
    })

    it('revokes pending invitations at delete time', async () => {
      const owner = await registerOwner(app, 'del-invites')
      const projectId = await createProject(app, owner.cookies, 'del-invites')
      const invite = await app.inject({
        method: 'POST',
        url: `${PROJECTS_URL}/${projectId}/invitations`,
        headers: { cookie: cookieHeader(owner.cookies) },
        payload: { email: `invitee-${randomUUID()}@example.com`, role: 'member' },
      })
      expect(invite.statusCode).toBe(201)
      await call(app, 'DELETE', `/${projectId}`, owner.cookies)
      const rows = await withOrg(owner.orgId, (tx) =>
        tx.select().from(projectInvitations).where(eq(projectInvitations.projectId, projectId))
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]?.revokedAt).not.toBeNull()
    })

    it('answers 404, not not_deleted, when restoring a purged tombstone', async () => {
      const owner = await registerOwner(app, 'del-tomb')
      const projectId = await createProject(app, owner.cookies, 'del-tomb')
      await call(app, 'DELETE', `/${projectId}`, owner.cookies)
      await withOrg(owner.orgId, (tx) =>
        tx
          .update(projects)
          .set({ purgeAfter: new Date(Date.now() - 1000) })
          .where(eq(projects.id, projectId))
      )
      await runProjectPurgeJob()
      const res = await call(app, 'POST', `/${projectId}/restore`, owner.cookies)
      expect(res.statusCode).toBe(404)
      expect(res.json()).toMatchObject({ code: 'project_not_found' })
    })
  })

  describe('purge job', () => {
    it('hard-deletes a project past its purge date with its children, audits it, and spares the rest', async () => {
      const owner = await registerOwner(app, 'purge')
      const due = await createProject(app, owner.cookies, 'purge-due')
      const notYet = await createProject(app, owner.cookies, 'purge-not-yet')
      const restored = await createProject(app, owner.cookies, 'purge-restored')
      const credential = await createCredentialViaApi(app, owner.cookies, due)
      // A machine user (no active key) and a service endpoint ride along and must be erased too.
      const machineUser = await app.inject({
        method: 'POST',
        url: `${PROJECTS_URL}/${due}/machine-users`,
        headers: { cookie: cookieHeader(owner.cookies) },
        payload: { name: 'purge-bot', role: 'member' },
      })
      expect(machineUser.statusCode).toBe(201)
      const endpoint = await call(app, 'POST', `/${due}/service-endpoints`, owner.cookies, {
        name: 'purge health',
        url: 'https://example.com/health',
      })
      expect(endpoint.statusCode).toBe(201)
      for (const id of [due, notYet, restored]) await call(app, 'DELETE', `/${id}`, owner.cookies)
      await call(app, 'POST', `/${restored}/restore`, owner.cookies)

      // Age the due project and the restored one (restore clears its date, so it must survive).
      await withOrg(owner.orgId, (tx) =>
        tx
          .update(projects)
          .set({ purgeAfter: new Date(Date.now() - 1000) })
          .where(eq(projects.id, due))
      )

      await runProjectPurgeJob()

      // The row stays as a tombstone (the audit log references it); its data and identity are gone.
      const tombstone = await projectRow(owner.orgId, due)
      expect(tombstone).toMatchObject({
        name: 'Purged project',
        slug: `purged-${due}`,
        description: null,
        creationRequestId: null,
        createdBy: null,
      })
      expect(tombstone?.purgedAt).not.toBeNull()
      expect(tombstone?.urls).toEqual([])
      expect((await call(app, 'GET', `/${due}`, owner.cookies)).statusCode).toBe(404)
      const listedAfter = await call(app, 'GET', '/deleted', owner.cookies)
      expect(
        listedAfter.json<{ data: { items: { id: string }[] } }>().data.items.map((p) => p.id)
      ).not.toContain(due)
      expect(await projectRow(owner.orgId, notYet)).toBeDefined()
      expect(await projectRow(owner.orgId, restored)).toBeDefined()
      const leftover = await withOrg(owner.orgId, (tx) =>
        tx.select({ id: credentials.id }).from(credentials).where(eq(credentials.id, credential.id))
      )
      expect(leftover).toEqual([])
      const leftoverRows = await withOrg(owner.orgId, async (tx) => ({
        machineUsers: await tx
          .select({ id: machineUsers.id })
          .from(machineUsers)
          .where(eq(machineUsers.projectId, due)),
        endpoints: await tx
          .select({ id: serviceEndpoints.id })
          .from(serviceEndpoints)
          .where(eq(serviceEndpoints.projectId, due)),
      }))
      expect(leftoverRows).toEqual({ machineUsers: [], endpoints: [] })
      const audit = await archiveAuditRowsFor(owner.orgId, AuditEvent.PROJECT_PURGED, due)
      expect(audit).toHaveLength(1)
      expect(audit[0]?.payload).toMatchObject({ projectId: due, slug: expect.any(String) })

      // A second run is a no-op.
      await runProjectPurgeJob()
      expect(await archiveAuditRowsFor(owner.orgId, AuditEvent.PROJECT_PURGED, due)).toHaveLength(1)
    })
  })
})
