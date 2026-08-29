import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { auditLogEntries, credentials, projects } from '@project-vault/db/schema'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import { createMembershipTestHelpers } from '../../__tests__/helpers/membership-test-helpers.js'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
} from '../../__tests__/helpers/auth-test-helpers.js'
import {
  bootCredentialRouteApp,
  createCredentialTestProject,
  createCredentialViaApi,
} from './credential-route-test-helpers.js'

const { createApp, initVault } = await bootstrapRouteIntegrationTest()

type TestApp = Awaited<ReturnType<typeof createApp>>

const TEST_PASSPHRASE = 'credential-archival-passphrase'

const { registerOwner, addUserToOrg, addProjectMember } = createMembershipTestHelpers({
  emailPrefix: 'cred-archival',
  orgNamePrefix: 'Credential Archival',
})

function archiveUrl(projectId: string, credentialId: string): string {
  return `/api/v1/projects/${projectId}/credentials/${credentialId}/archive`
}
function unarchiveUrl(projectId: string, credentialId: string): string {
  return `/api/v1/projects/${projectId}/credentials/${credentialId}/unarchive`
}

function archiveCredential(app: TestApp, cookies: Record<string, string>, p: string, c: string) {
  return app.inject({
    method: 'POST',
    url: archiveUrl(p, c),
    headers: { cookie: cookieHeader(cookies) },
  })
}
function unarchiveCredential(app: TestApp, cookies: Record<string, string>, p: string, c: string) {
  return app.inject({
    method: 'POST',
    url: unarchiveUrl(p, c),
    headers: { cookie: cookieHeader(cookies) },
  })
}

async function currentArchivedAt(orgId: string, credentialId: string): Promise<Date | null> {
  const rows = await withOrg(orgId, (tx) =>
    tx
      .select({ archivedAt: credentials.archivedAt })
      .from(credentials)
      .where(eq(credentials.id, credentialId))
  )
  return rows[0]?.archivedAt ?? null
}

async function initiateRotationViaApi(
  app: TestApp,
  cookies: Record<string, string>,
  projectId: string,
  credentialId: string
) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/projects/${projectId}/credentials/${credentialId}/rotations`,
    headers: { cookie: cookieHeader(cookies) },
    payload: { newValue: 'new-rotated-value' },
  })
}

async function createShareViaApi(
  app: TestApp,
  cookies: Record<string, string>,
  projectId: string,
  credentialId: string,
  recipientUserId: string
) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/projects/${projectId}/credentials/${credentialId}/shares`,
    headers: { cookie: cookieHeader(cookies) },
    payload: {
      recipientUserId,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      singleUse: false,
    },
  })
}

describe.sequential('credential archival routes (28.5)', () => {
  let app: TestApp

  beforeAll(async () => {
    app = await bootCredentialRouteApp(createApp, initVault, TEST_PASSPHRASE)
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  describe('POST .../archive', () => {
    it('an org-owner (not the project owner) archives a clean secret (AC2 happy path)', async () => {
      const owner = await registerOwner(app, 'archive-clean')
      const projectId = await createCredentialTestProject(app, owner.cookies, 'archive-clean')
      const credential = await createCredentialViaApi(app, owner.cookies, projectId)

      const orgOwner = await addUserToOrg(app, owner.orgId, 'org-owner', { orgRole: 'owner' })

      const res = await archiveCredential(app, orgOwner.cookies, projectId, credential.id)
      expect(res.statusCode).toBe(200)
      const body = res.json<{
        data: { id: string; name: string; archivedAt: string; isArchived: boolean }
      }>()
      expect(body.data.id).toBe(credential.id)
      expect(body.data.isArchived).toBe(true)
      expect(body.data.archivedAt).not.toBeNull()

      const auditRows = await withOrg(owner.orgId, (tx) =>
        tx
          .select({ payload: auditLogEntries.payload, resourceId: auditLogEntries.resourceId })
          .from(auditLogEntries)
          .where(
            and(
              eq(auditLogEntries.eventType, 'credential.archived'),
              eq(auditLogEntries.resourceId, credential.id)
            )
          )
      )
      expect(auditRows).toHaveLength(1)
      expect(auditRows[0]?.payload).toMatchObject({ authorizedVia: 'org_owner' })
    })

    it('403 for a member-role caller (below the admin floor)', async () => {
      const owner = await registerOwner(app, 'archive-member')
      const projectId = await createCredentialTestProject(app, owner.cookies, 'archive-member')
      const credential = await createCredentialViaApi(app, owner.cookies, projectId)
      const member = await addUserToOrg(app, owner.orgId, 'member', { orgRole: 'member' })
      await addProjectMember(owner.orgId, projectId, member.userId, 'member')

      const res = await archiveCredential(app, member.cookies, projectId, credential.id)
      expect(res.statusCode).toBe(403)
      expect(await currentArchivedAt(owner.orgId, credential.id)).toBeNull()
    })

    it('403 for an admin who is neither project owner nor org owner', async () => {
      const owner = await registerOwner(app, 'archive-admin')
      const projectId = await createCredentialTestProject(app, owner.cookies, 'archive-admin')
      const credential = await createCredentialViaApi(app, owner.cookies, projectId)
      const admin = await addUserToOrg(app, owner.orgId, 'admin', { orgRole: 'admin' })

      const res = await archiveCredential(app, admin.cookies, projectId, credential.id)
      expect(res.statusCode).toBe(403)
      expect(await currentArchivedAt(owner.orgId, credential.id)).toBeNull()
    })

    it('409 active_rotations blocks archival; archivedAt stays null', async () => {
      const owner = await registerOwner(app, 'archive-rotation')
      const projectId = await createCredentialTestProject(app, owner.cookies, 'archive-rotation')
      const credential = await createCredentialViaApi(app, owner.cookies, projectId)

      const rotationRes = await initiateRotationViaApi(app, owner.cookies, projectId, credential.id)
      expect(rotationRes.statusCode).toBe(201)

      const res = await archiveCredential(app, owner.cookies, projectId, credential.id)
      expect(res.statusCode).toBe(409)
      expect(res.json<{ error: string }>().error).toBe('active_rotations')
      expect(await currentArchivedAt(owner.orgId, credential.id)).toBeNull()
    })

    it('409 active_shares blocks archival; archivedAt stays null', async () => {
      const owner = await registerOwner(app, 'archive-share')
      const projectId = await createCredentialTestProject(app, owner.cookies, 'archive-share')
      const credential = await createCredentialViaApi(app, owner.cookies, projectId)
      const recipient = await addUserToOrg(app, owner.orgId, 'recipient', { orgRole: 'member' })
      await addProjectMember(owner.orgId, projectId, recipient.userId, 'member')

      const shareRes = await createShareViaApi(
        app,
        owner.cookies,
        projectId,
        credential.id,
        recipient.userId
      )
      expect(shareRes.statusCode).toBe(201)

      const res = await archiveCredential(app, owner.cookies, projectId, credential.id)
      expect(res.statusCode).toBe(409)
      expect(res.json<{ error: string }>().error).toBe('active_shares')
      expect(await currentArchivedAt(owner.orgId, credential.id)).toBeNull()
    })

    it('409 already_archived on a second archive attempt (idempotent, not silent)', async () => {
      const owner = await registerOwner(app, 'archive-twice')
      const projectId = await createCredentialTestProject(app, owner.cookies, 'archive-twice')
      const credential = await createCredentialViaApi(app, owner.cookies, projectId)

      const first = await archiveCredential(app, owner.cookies, projectId, credential.id)
      expect(first.statusCode).toBe(200)

      const second = await archiveCredential(app, owner.cookies, projectId, credential.id)
      expect(second.statusCode).toBe(409)
      expect(second.json<{ code: string }>().code).toBe('already_archived')
    })
  })

  describe('POST .../unarchive', () => {
    it('restores an archived secret (AC3 happy path)', async () => {
      const owner = await registerOwner(app, 'unarchive-clean')
      const projectId = await createCredentialTestProject(app, owner.cookies, 'unarchive-clean')
      const credential = await createCredentialViaApi(app, owner.cookies, projectId)
      await archiveCredential(app, owner.cookies, projectId, credential.id)

      const res = await unarchiveCredential(app, owner.cookies, projectId, credential.id)
      expect(res.statusCode).toBe(200)
      const body = res.json<{ data: { archivedAt: string | null; isArchived: boolean } }>()
      expect(body.data.archivedAt).toBeNull()
      expect(body.data.isArchived).toBe(false)
      expect(await currentArchivedAt(owner.orgId, credential.id)).toBeNull()
    })

    it('409 not_archived for a never-archived secret', async () => {
      const owner = await registerOwner(app, 'unarchive-never')
      const projectId = await createCredentialTestProject(app, owner.cookies, 'unarchive-never')
      const credential = await createCredentialViaApi(app, owner.cookies, projectId)

      const res = await unarchiveCredential(app, owner.cookies, projectId, credential.id)
      expect(res.statusCode).toBe(409)
      expect(res.json<{ code: string }>().code).toBe('not_archived')
    })

    it("410 project_archived when the secret's own project is archived (existing guard applies first)", async () => {
      const owner = await registerOwner(app, 'unarchive-proj-archived')
      const projectId = await createCredentialTestProject(
        app,
        owner.cookies,
        'unarchive-proj-archived'
      )
      const credential = await createCredentialViaApi(app, owner.cookies, projectId)
      await archiveCredential(app, owner.cookies, projectId, credential.id)
      await withOrg(owner.orgId, (tx) =>
        tx.update(projects).set({ archivedAt: new Date() }).where(eq(projects.id, projectId))
      )

      const res = await unarchiveCredential(app, owner.cookies, projectId, credential.id)
      expect(res.statusCode).toBe(410)
      expect(res.json<{ code: string }>().code).toBe('project_archived')
    })
  })

  describe('cross-cutting 410 sweep on an archived secret (AC4)', () => {
    async function setUpArchivedCredential(label: string) {
      const owner = await registerOwner(app, label)
      const projectId = await createCredentialTestProject(app, owner.cookies, label)
      const credential = await createCredentialViaApi(app, owner.cookies, projectId)
      const archiveRes = await archiveCredential(app, owner.cookies, projectId, credential.id)
      expect(archiveRes.statusCode).toBe(200)
      return { owner, projectId, credentialId: credential.id }
    }

    it('GET credential detail still serves data (reads remain available)', async () => {
      const { owner, projectId, credentialId } = await setUpArchivedCredential('sweep-get')
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${projectId}/credentials/${credentialId}`,
        headers: { cookie: cookieHeader(owner.cookies) },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json<{ data: { archivedAt: string | null } }>().data.archivedAt).not.toBeNull()
    })

    it('POST .../versions rejects with 410 credential_archived, no version created', async () => {
      const { owner, projectId, credentialId } = await setUpArchivedCredential('sweep-versions')
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${projectId}/credentials/${credentialId}/versions`,
        headers: { cookie: cookieHeader(owner.cookies) },
        payload: { value: 'new-value' },
      })
      expect(res.statusCode).toBe(410)
      expect(res.json<{ code: string }>().code).toBe('credential_archived')
    })

    it('PUT .../tags rejects with 410 credential_archived', async () => {
      const { owner, projectId, credentialId } = await setUpArchivedCredential('sweep-tags')
      const res = await app.inject({
        method: 'PUT',
        url: `/api/v1/projects/${projectId}/credentials/${credentialId}/tags`,
        headers: { cookie: cookieHeader(owner.cookies) },
        payload: { tags: ['x'] },
      })
      expect(res.statusCode).toBe(410)
      expect(res.json<{ code: string }>().code).toBe('credential_archived')
    })

    it('POST .../dependencies rejects with 410 credential_archived', async () => {
      const { owner, projectId, credentialId } = await setUpArchivedCredential('sweep-deps')
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${projectId}/credentials/${credentialId}/dependencies`,
        headers: { cookie: cookieHeader(owner.cookies) },
        payload: { systemName: 'CI Pipeline' },
      })
      expect(res.statusCode).toBe(410)
      expect(res.json<{ code: string }>().code).toBe('credential_archived')
    })

    it('PATCH .../:credentialId (lifecycle) rejects with 410 credential_archived', async () => {
      const { owner, projectId, credentialId } = await setUpArchivedCredential('sweep-lifecycle')
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/projects/${projectId}/credentials/${credentialId}`,
        headers: { cookie: cookieHeader(owner.cookies) },
        payload: { cacheable: false },
      })
      expect(res.statusCode).toBe(410)
      expect(res.json<{ code: string }>().code).toBe('credential_archived')
    })

    it('POST .../rotations (initiate) rejects with 410 credential_archived, distinct from project_archived', async () => {
      const { owner, projectId, credentialId } = await setUpArchivedCredential('sweep-rotation')
      const res = await initiateRotationViaApi(app, owner.cookies, projectId, credentialId)
      expect(res.statusCode).toBe(410)
      expect(res.json<{ code: string }>().code).toBe('credential_archived')
    })

    it('POST .../shares rejects with 410 credential_archived, no token minted', async () => {
      const { owner, projectId, credentialId } = await setUpArchivedCredential('sweep-shares')
      const recipient = await addUserToOrg(app, owner.orgId, 'sweep-recipient', {
        orgRole: 'member',
      })
      await addProjectMember(owner.orgId, projectId, recipient.userId, 'member')

      const res = await createShareViaApi(
        app,
        owner.cookies,
        projectId,
        credentialId,
        recipient.userId
      )
      expect(res.statusCode).toBe(410)
      expect(res.json<{ code: string }>().code).toBe('credential_archived')
    })
  })

  describe('GET /:projectId/credentials list filtering (AC5)', () => {
    it('excludes archived secrets by default; includeArchived=true includes them with correct totals', async () => {
      const owner = await registerOwner(app, 'list-archived')
      const projectId = await createCredentialTestProject(app, owner.cookies, 'list-archived')
      const activeOne = await createCredentialViaApi(app, owner.cookies, projectId, {
        name: `active-1-${randomUUID()}`,
        value: 'v',
      })
      const activeTwo = await createCredentialViaApi(app, owner.cookies, projectId, {
        name: `active-2-${randomUUID()}`,
        value: 'v',
      })
      const archived = await createCredentialViaApi(app, owner.cookies, projectId, {
        name: `archived-1-${randomUUID()}`,
        value: 'v',
      })
      await archiveCredential(app, owner.cookies, projectId, archived.id)

      const defaultList = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${projectId}/credentials`,
        headers: { cookie: cookieHeader(owner.cookies) },
      })
      expect(defaultList.statusCode).toBe(200)
      const defaultBody = defaultList.json<{
        data: { items: { id: string }[]; total: number }
      }>()
      expect(defaultBody.data.items.map((i) => i.id).sort()).toEqual(
        [activeOne.id, activeTwo.id].sort()
      )
      expect(defaultBody.data.total).toBe(2)

      const includeArchivedList = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${projectId}/credentials?includeArchived=true`,
        headers: { cookie: cookieHeader(owner.cookies) },
      })
      expect(includeArchivedList.statusCode).toBe(200)
      const includeBody = includeArchivedList.json<{
        data: { items: { id: string; archivedAt: string | null }[]; total: number }
      }>()
      expect(includeBody.data.items).toHaveLength(3)
      expect(includeBody.data.total).toBe(3)
      const archivedItem = includeBody.data.items.find((i) => i.id === archived.id)
      expect(archivedItem?.archivedAt).not.toBeNull()
    })
  })
})
