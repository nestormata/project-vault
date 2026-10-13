import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { getDb, withOrg } from '@project-vault/db'
import { auditLogEntries, credentialShares, orgMemberships, users } from '@project-vault/db/schema'
import type { CredentialSharingHost, ExtensionManifest } from '@project-vault/extension-api'
import {
  CredentialSharingActingUserInvalidError,
  CredentialSharingActingUserMismatchError,
  CredentialSharingNotAuthorizedError,
} from '@project-vault/extension-api'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
} from '../__tests__/helpers/auth-test-helpers.js'
import { resetVaultForTest } from '../__tests__/helpers/vault-test-cleanup.js'
import { createMembershipTestHelpers } from '../__tests__/helpers/membership-test-helpers.js'
import {
  bootCredentialRouteApp,
  createCredentialTestProject,
  createCredentialViaApi,
} from '../modules/credentials/credential-route-test-helpers.js'
import { computeRotationRecommendedNudges } from '../modules/credential-shares/nudge.js'
import { autoRevokeSharesForDeactivatedUser } from '../modules/credential-shares/service.js'
import {
  buildCredentialSharingHost,
  __resetCredentialSharingHostRateLimitForTests,
  __resetCredentialSharingOrgRateLimitForTests,
} from './credential-sharing-host.js'
import { runWithRequestContext } from './request-context.js'

/**
 * Story 65.6 Task 1 — real-Postgres coverage (RLS on, the app role) for the acting user recorded on
 * host-created shares: D1 resolution, audit attribution unchanged, the native revoke/list rules on
 * host rows (AC2), `sharedBy` (AC3), `viewer` (AC4) and `actor` (AC5). Every denial asserts that no
 * row, state change or audit entry was written.
 */

const { createApp, initVault } = await bootstrapRouteIntegrationTest()
type TestApp = Awaited<ReturnType<typeof createApp>>

const { registerOwner, addUserToOrg, addProjectMember } = createMembershipTestHelpers({
  emailPrefix: 'cred-sharing-acting',
  orgNamePrefix: 'Credential Sharing Acting Org',
})

const EXTENSION_NAME = 'com.acme.credential-sharing-acting-fixture'
const MANIFEST: ExtensionManifest = { name: EXTENSION_NAME, apiVersion: '3.36.0', capabilities: [] }
const SHARE_CREATED = 'credential.share_created'
const SHARE_REVOKED = 'credential.share_revoked'
const INSUFFICIENT_ROLE = 'insufficient_role'
const RECIPIENT_EMAIL = 'recipient@invalid'
// A well-formed id no user has.
const UNKNOWN_USER_ID = randomUUID()

function futureIso(ms = 60 * 60 * 1000): string {
  return new Date(Date.now() + ms).toISOString()
}

function sharesUrl(projectId: string, credentialId: string, suffix = ''): string {
  return `/api/v1/projects/${projectId}/credentials/${credentialId}/shares${suffix}`
}

describe('credentialSharing acting user — real Postgres (Story 65.6)', () => {
  let app: TestApp
  let host: CredentialSharingHost
  let owner: Awaited<ReturnType<typeof registerOwner>>
  let memberOne: Awaited<ReturnType<typeof addUserToOrg>>
  let memberTwo: Awaited<ReturnType<typeof addUserToOrg>>
  let admin: Awaited<ReturnType<typeof addUserToOrg>>
  let foreignOwner: Awaited<ReturnType<typeof registerOwner>>
  let projectId: string
  let orgId: string

  beforeAll(async () => {
    await resetVaultForTest()
    app = await bootCredentialRouteApp(createApp, initVault, 'credential-sharing-acting-passphrase')
    owner = await registerOwner(app, 'owner')
    orgId = owner.orgId
    projectId = await createCredentialTestProject(app, owner.cookies, 'acting')
    memberOne = await addUserToOrg(app, orgId, 'member-one', { orgRole: 'member' })
    memberTwo = await addUserToOrg(app, orgId, 'member-two', { orgRole: 'member' })
    admin = await addUserToOrg(app, orgId, 'admin', { orgRole: 'admin' })
    for (const user of [memberOne, memberTwo]) {
      await addProjectMember(orgId, projectId, user.userId, 'member')
    }
    await addProjectMember(orgId, projectId, admin.userId, 'admin')
    foreignOwner = await registerOwner(app, 'foreign')

    // The facade resolves its machine user by the extension's manifest name; the OWNER provisions
    // it, so `shared_by` of every host row is the owner, never one of the acting members.
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/machine-users`,
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { name: EXTENSION_NAME, role: 'member' },
    })
    expect(created.statusCode).toBe(201)
    const machineUserId = created.json<{ data: { id: string } }>().data.id
    const key = await app.inject({
      method: 'POST',
      url: `/api/v1/machine-users/${machineUserId}/api-keys`,
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { name: 'acting-user-fixture-key' },
    })
    expect(key.statusCode).toBe(201)
  })

  beforeEach(() => {
    __resetCredentialSharingHostRateLimitForTests()
    __resetCredentialSharingOrgRateLimitForTests()
    host = buildCredentialSharingHost(MANIFEST)
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  async function newCredential(label: string): Promise<string> {
    const credential = await createCredentialViaApi(app, owner.cookies, projectId, {
      name: `acting-${label}`,
      value: 'acting-secret',
    })
    return credential.id
  }

  /** A host create, optionally inside an ambient request context for `ambientUserId`. */
  async function hostCreate(
    credentialId: string,
    options: { ambientUserId?: string; actingUserId?: string } = {}
  ) {
    const call = () =>
      host.createExternalShare({
        organizationId: orgId,
        projectId,
        credentialId,
        recipientEmail: RECIPIENT_EMAIL,
        expiresAt: futureIso(),
        fieldKey: 'value',
        ...(options.actingUserId ? { actingUserId: options.actingUserId } : {}),
      })
    const result = options.ambientUserId
      ? await runWithRequestContext({ orgId, userId: options.ambientUserId }, call)
      : await call()
    if (result.status !== 'ok') throw new Error(`create failed: ${result.status}`)
    return result.share
  }

  function shareRow(shareId: string) {
    return withOrg(orgId, async (tx) => {
      const [row] = await tx.select().from(credentialShares).where(eq(credentialShares.id, shareId))
      if (!row) throw new Error('share row missing')
      return row
    })
  }

  function shareCount(credentialId: string): Promise<number> {
    return withOrg(orgId, async (tx) => {
      const rows = await tx
        .select({ id: credentialShares.id })
        .from(credentialShares)
        .where(eq(credentialShares.credentialId, credentialId))
      return rows.length
    })
  }

  function auditRows(eventType: string) {
    return withOrg(orgId, (tx) =>
      tx.select().from(auditLogEntries).where(eq(auditLogEntries.eventType, eventType))
    )
  }

  async function auditCount(eventType: string): Promise<number> {
    return (await auditRows(eventType)).length
  }

  /** Makes a host row look like one created before this story: no recorded acting user, and the
   *  given user as the machine user's provisioning human. */
  async function makeLegacy(shareId: string, provisionerUserId: string): Promise<void> {
    await withOrg(orgId, (tx) =>
      tx
        .update(credentialShares)
        .set({ actingUserId: null, sharedBy: provisionerUserId })
        .where(eq(credentialShares.id, shareId))
    )
  }

  async function nativeList(
    cookies: Record<string, string>,
    credentialId: string
  ): Promise<string[]> {
    const response = await app.inject({
      method: 'GET',
      url: sharesUrl(projectId, credentialId),
      headers: { cookie: cookieHeader(cookies) },
    })
    expect(response.statusCode).toBe(200)
    return response.json<{ data: { items: { id: string }[] } }>().data.items.map((i) => i.id)
  }

  function nativeRevoke(cookies: Record<string, string>, credentialId: string, shareId: string) {
    return app.inject({
      method: 'POST',
      url: sharesUrl(projectId, credentialId, `/${shareId}/revoke`),
      headers: { cookie: cookieHeader(cookies) },
    })
  }

  describe('AC1 — acting user recorded on create, audit attribution unchanged', () => {
    it('inside a request: acting_user_id = the request user, shared_by = the provisioner, audit = machine user', async () => {
      const credentialId = await newCredential('ambient')
      const share = await hostCreate(credentialId, { ambientUserId: memberOne.userId })

      const row = await shareRow(share.id)
      expect(row).toMatchObject({
        hostCreated: true,
        actingUserId: memberOne.userId,
        sharedBy: owner.userId,
      })
      expect(share.sharedBy).toBe(memberOne.userId)

      const [created] = (await auditRows(SHARE_CREATED)).filter((r) => r.resourceId === share.id)
      expect(created?.actorType).toBe('machine_user')
      expect(created?.actorTokenId).toBeNull()
      expect(JSON.stringify(created?.payload)).not.toContain(memberOne.userId)
    })

    it('outside a request: a supplied actingUserId that is an active member is recorded', async () => {
      const credentialId = await newCredential('fallback')
      const share = await hostCreate(credentialId, { actingUserId: memberTwo.userId })
      expect((await shareRow(share.id)).actingUserId).toBe(memberTwo.userId)
      expect(share.sharedBy).toBe(memberTwo.userId)
    })

    it('neither: created as a host row with an unknown acting user, sharedBy null, not an error', async () => {
      const credentialId = await newCredential('unknown')
      const share = await hostCreate(credentialId)
      expect(await shareRow(share.id)).toMatchObject({ hostCreated: true, actingUserId: null })
      expect(share.sharedBy).toBeNull()
    })

    it('a native share keeps host_created = false and no acting user', async () => {
      const credentialId = await newCredential('native')
      const recipient = memberTwo
      const response = await app.inject({
        method: 'POST',
        url: sharesUrl(projectId, credentialId),
        headers: { cookie: cookieHeader(memberOne.cookies) },
        payload: { recipientUserId: recipient.userId, expiresAt: futureIso() },
      })
      expect(response.statusCode).toBe(201)
      const row = await shareRow(response.json<{ data: { id: string } }>().data.id)
      expect(row).toMatchObject({
        hostCreated: false,
        actingUserId: null,
        sharedBy: memberOne.userId,
      })
    })

    it.each([
      ['a member of a different org only', () => foreignOwner.userId],
      ['a deactivated member', () => 'deactivated'],
      ['an id that does not exist', () => UNKNOWN_USER_ID],
    ])('spoofed acting user (%s): one generic error, no row, no audit entry', async (_l, pick) => {
      const credentialId = await newCredential('spoof')
      let actingUserId = pick()
      if (actingUserId === 'deactivated') {
        actingUserId = memberTwo.userId
        await withOrg(orgId, (tx) =>
          tx
            .update(orgMemberships)
            .set({ status: 'deactivated' })
            .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, actingUserId)))
        )
      }
      const auditBefore = await auditCount(SHARE_CREATED)
      try {
        const rejection = await hostCreate(credentialId, { actingUserId }).then(
          () => undefined,
          (error: unknown) => error
        )
        expect(rejection).toBeInstanceOf(CredentialSharingActingUserInvalidError)
        expect((rejection as Error).message).not.toContain(actingUserId)
        expect(await shareCount(credentialId)).toBe(0)
        expect(await auditCount(SHARE_CREATED)).toBe(auditBefore)
      } finally {
        await withOrg(orgId, (tx) =>
          tx
            .update(orgMemberships)
            .set({ status: 'active' })
            .where(
              and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, memberTwo.userId))
            )
        )
      }
    })

    it('ambient user and a different actingUserId: mismatch error, nothing written', async () => {
      const credentialId = await newCredential('mismatch')
      const auditBefore = await auditCount(SHARE_CREATED)
      await expect(
        hostCreate(credentialId, {
          ambientUserId: memberOne.userId,
          actingUserId: memberTwo.userId,
        })
      ).rejects.toBeInstanceOf(CredentialSharingActingUserMismatchError)
      expect(await shareCount(credentialId)).toBe(0)
      expect(await auditCount(SHARE_CREATED)).toBe(auditBefore)
    })

    it('an ambient context bound for another org is never trusted', async () => {
      const credentialId = await newCredential('cross-org-ambient')
      const result = await runWithRequestContext(
        { orgId: foreignOwner.orgId, userId: foreignOwner.userId },
        () =>
          host.createExternalShare({
            organizationId: orgId,
            projectId,
            credentialId,
            recipientEmail: RECIPIENT_EMAIL,
            expiresAt: futureIso(),
            fieldKey: 'value',
          })
      )
      expect(result.status).toBe('ok')
      if (result.status !== 'ok') return
      expect((await shareRow(result.share.id)).actingUserId).toBeNull()
    })
  })

  describe('AC2 — native routes apply the sharer rule to host rows', () => {
    it('revoke: the acting member and an admin may, another member gets 403 and no state change', async () => {
      const credentialId = await newCredential('native-revoke')
      const share = await hostCreate(credentialId, { ambientUserId: memberOne.userId })

      const denied = await nativeRevoke(memberTwo.cookies, credentialId, share.id)
      expect(denied.statusCode).toBe(403)
      expect(denied.json<{ code: string }>().code).toBe(INSUFFICIENT_ROLE)
      expect((await shareRow(share.id)).status).toBe('active')

      const byActing = await nativeRevoke(memberOne.cookies, credentialId, share.id)
      expect(byActing.statusCode).toBe(200)

      const second = await hostCreate(credentialId, { ambientUserId: memberOne.userId })
      const byAdmin = await nativeRevoke(admin.cookies, credentialId, second.id)
      expect(byAdmin.statusCode).toBe(200)
    })

    it('list: a member sees the host rows they acted on, never another member’s; an admin sees all', async () => {
      const credentialId = await newCredential('native-list')
      const mine = await hostCreate(credentialId, { ambientUserId: memberOne.userId })
      const theirs = await hostCreate(credentialId, { ambientUserId: memberTwo.userId })

      expect(await nativeList(memberOne.cookies, credentialId)).toEqual([mine.id])
      expect(await nativeList(memberTwo.cookies, credentialId)).toEqual([theirs.id])
      expect((await nativeList(admin.cookies, credentialId)).sort()).toEqual(
        [mine.id, theirs.id].sort()
      )
    })

    it('the native response reports the effective sharer (the acting user) as sharedBy', async () => {
      const credentialId = await newCredential('native-serialize')
      const share = await hostCreate(credentialId, { ambientUserId: memberOne.userId })
      const response = await app.inject({
        method: 'GET',
        url: sharesUrl(projectId, credentialId),
        headers: { cookie: cookieHeader(admin.cookies) },
      })
      const items = response.json<{ data: { items: { id: string; sharedBy: string }[] } }>().data
        .items
      expect(items.find((item) => item.id === share.id)?.sharedBy).toBe(memberOne.userId)
    })

    it('a legacy host row (no acting user) keeps today’s native rule: the provisioner is the sharer', async () => {
      const credentialId = await newCredential('native-legacy')
      const share = await hostCreate(credentialId)
      await makeLegacy(share.id, memberOne.userId)

      expect(await nativeList(memberOne.cookies, credentialId)).toEqual([share.id])
      expect(await nativeList(memberTwo.cookies, credentialId)).toEqual([])
      expect((await nativeRevoke(memberTwo.cookies, credentialId, share.id)).statusCode).toBe(403)
      expect((await nativeRevoke(memberOne.cookies, credentialId, share.id)).statusCode).toBe(200)
    })

    it('deactivating the acting user auto-revokes their host shares; the provisioner’s deactivation only takes legacy rows', async () => {
      const credentialId = await newCredential('auto-revoke')
      const acted = await hostCreate(credentialId, { ambientUserId: memberOne.userId })
      const other = await hostCreate(credentialId, { ambientUserId: memberTwo.userId })
      const legacy = await hostCreate(credentialId)
      await makeLegacy(legacy.id, memberTwo.userId)

      const revoked = await withOrg(orgId, (tx) =>
        autoRevokeSharesForDeactivatedUser(tx, { orgId, userId: memberOne.userId })
      )
      // The sweep is org-wide, so earlier tests' still-active rows of this user are in it too.
      const revokedIds = revoked.map((row) => row.id)
      expect(revokedIds).toContain(acted.id)
      expect(revokedIds).not.toContain(other.id)
      expect(revokedIds).not.toContain(legacy.id)
      expect(revoked.every((row) => (row.actingUserId ?? row.sharedBy) === memberOne.userId)).toBe(
        true
      )
      expect((await shareRow(other.id)).status).toBe('active')
      expect((await shareRow(legacy.id)).status).toBe('active')

      // memberTwo is both the acting user of `other` and the "provisioner" of `legacy`.
      const revokedTwo = await withOrg(orgId, (tx) =>
        autoRevokeSharesForDeactivatedUser(tx, { orgId, userId: memberTwo.userId })
      )
      expect(revokedTwo.map((row) => row.id)).toEqual(expect.arrayContaining([other.id, legacy.id]))
    })

    it('the rotation nudge shows the recipient to the acting user and hides it from another member', async () => {
      const credentialId = await newCredential('nudge')
      await hostCreate(credentialId, { ambientUserId: memberOne.userId })
      const nudgeFor = (viewerUserId: string, viewerIsAdmin: boolean) =>
        withOrg(orgId, (tx) =>
          computeRotationRecommendedNudges(tx, { orgId, credentialId, viewerUserId, viewerIsAdmin })
        )

      expect((await nudgeFor(memberOne.userId, false))[0]?.mostRecentSharedWith).toBe(
        RECIPIENT_EMAIL
      )
      expect((await nudgeFor(memberTwo.userId, false))[0]?.mostRecentSharedWith).toBeNull()
      expect((await nudgeFor(admin.userId, true))[0]?.mostRecentSharedWith).toBe(RECIPIENT_EMAIL)
    })

    it('the consent page names the acting human, and the provisioner when the actor is unknown', async () => {
      const credentialId = await newCredential('consent')
      // Created through the facade so the raw token is in hand (the record never carries it).
      const tokenActing = await host.createExternalShare({
        organizationId: orgId,
        projectId,
        credentialId,
        recipientEmail: 'consent-a@invalid',
        expiresAt: futureIso(),
        fieldKey: 'value',
        actingUserId: memberOne.userId,
      })
      const tokenUnknown = await host.createExternalShare({
        organizationId: orgId,
        projectId,
        credentialId,
        recipientEmail: 'consent-b@invalid',
        expiresAt: futureIso(),
        fieldKey: 'value',
      })
      if (tokenActing.status !== 'ok' || tokenUnknown.status !== 'ok') throw new Error('create')
      const acting = await host.findShareByToken(tokenActing.token)
      const unknown = await host.findShareByToken(tokenUnknown.token)
      if (acting.status !== 'ok' || unknown.status !== 'ok') throw new Error('find')
      expect(acting.sharedByDisplayName).toBe(memberOne.email.split('@')[0])
      const [provisioner] = await getDb()
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, owner.userId))
      expect(unknown.sharedByDisplayName).toBe(provisioner?.email.split('@')[0])
    })
  })

  describe('AC3 — sharedBy on every extension record', () => {
    it('create, find, reveal, revoke and list all carry the same sharedBy; a native row reports shared_by', async () => {
      const credentialId = await newCredential('shared-by')
      const created = await host.createExternalShare({
        organizationId: orgId,
        projectId,
        credentialId,
        recipientEmail: RECIPIENT_EMAIL,
        expiresAt: futureIso(),
        fieldKey: 'value',
        actingUserId: memberOne.userId,
      })
      if (created.status !== 'ok') throw new Error('create')
      expect(created.share.sharedBy).toBe(memberOne.userId)

      const found = await host.findShareByToken(created.token)
      expect(found.status === 'ok' && found.share.sharedBy).toBe(memberOne.userId)
      const revealed = await host.revealShare(created.token)
      expect(revealed.status === 'ok' && revealed.share.sharedBy).toBe(memberOne.userId)
      expect(Object.keys(created.share)).toContain('sharedBy')

      const native = await app.inject({
        method: 'POST',
        url: sharesUrl(projectId, credentialId),
        headers: { cookie: cookieHeader(memberTwo.cookies) },
        payload: { recipientUserId: memberOne.userId, expiresAt: futureIso() },
      })
      const nativeId = native.json<{ data: { id: string } }>().data.id
      const list = await host.listSharesForCredential({
        organizationId: orgId,
        credentialId,
      })
      expect(list.items.find((item) => item.id === nativeId)?.sharedBy).toBe(memberTwo.userId)
    })
  })

  describe('AC4 — viewer on the list methods', () => {
    it('member sees only their own shares (total agrees), admin and owner see all, no viewer is unchanged', async () => {
      const credentialId = await newCredential('viewer')
      const one = await hostCreate(credentialId, { ambientUserId: memberOne.userId })
      const two = await hostCreate(credentialId, { ambientUserId: memberTwo.userId })
      const unknown = await hostCreate(credentialId)
      const base = { organizationId: orgId, credentialId }

      const asOne = await host.listSharesForCredential({
        ...base,
        viewer: { userId: memberOne.userId },
      })
      expect(asOne.items.map((i) => i.id)).toEqual([one.id])
      expect(asOne.total).toBe(1)

      for (const viewer of [admin, owner]) {
        const all = await host.listSharesForCredential({
          ...base,
          viewer: { userId: viewer.userId },
        })
        expect(all.items.map((i) => i.id).sort()).toEqual([one.id, two.id, unknown.id].sort())
        expect(all.total).toBe(3)
      }
      const noViewer = await host.listSharesForCredential(base)
      expect(noViewer.total).toBe(3)

      const orgScoped = await host.listSharesForOrganization({
        organizationId: orgId,
        viewer: { userId: memberTwo.userId },
        status: 'active',
        limit: 1,
        offset: 0,
      })
      expect(orgScoped.items.every((item) => item.sharedBy === memberTwo.userId)).toBe(true)
      expect(orgScoped.total).toBeGreaterThanOrEqual(1)
    })

    it('a legacy host row (unknown acting user) is never shown to a member, even the provisioner; admins see it', async () => {
      const credentialId = await newCredential('viewer-legacy')
      const legacy = await hostCreate(credentialId)
      await makeLegacy(legacy.id, memberOne.userId)

      const asProvisioner = await host.listSharesForCredential({
        organizationId: orgId,
        credentialId,
        viewer: { userId: memberOne.userId },
      })
      expect(asProvisioner).toEqual({ status: 'ok', items: [], total: 0 })
      const asAdmin = await host.listSharesForCredential({
        organizationId: orgId,
        credentialId,
        viewer: { userId: admin.userId },
      })
      expect(asAdmin.items.map((i) => i.id)).toEqual([legacy.id])
      expect(asAdmin.items[0]?.sharedBy).toBeNull()
    })

    it('a viewer who is not an active member, or only a member of another org, gets an empty list, never an error', async () => {
      const credentialId = await newCredential('viewer-cross-org')
      await hostCreate(credentialId, { ambientUserId: memberOne.userId })
      const empty = { status: 'ok', items: [], total: 0 }

      await expect(
        host.listSharesForCredential({
          organizationId: orgId,
          credentialId,
          viewer: { userId: foreignOwner.userId },
        })
      ).resolves.toEqual(empty)
      await expect(
        host.listSharesForOrganization({
          organizationId: orgId,
          viewer: { userId: UNKNOWN_USER_ID },
        })
      ).resolves.toEqual(empty)
      // A member of org O asked about org P: membership is resolved in P, never elsewhere.
      await expect(
        host.listSharesForOrganization({
          organizationId: foreignOwner.orgId,
          viewer: { userId: admin.userId },
        })
      ).resolves.toEqual(empty)
    })

    it('a viewer differing from the ambient request user is a mismatch error', async () => {
      const credentialId = await newCredential('viewer-mismatch')
      await expect(
        runWithRequestContext({ orgId, userId: memberOne.userId }, () =>
          host.listSharesForCredential({
            organizationId: orgId,
            credentialId,
            viewer: { userId: memberTwo.userId },
          })
        )
      ).rejects.toBeInstanceOf(CredentialSharingActingUserMismatchError)
    })
  })

  describe('AC5 — actor on revokeShare', () => {
    async function revokeAs(userId: string, credentialId: string, shareId: string) {
      return host.revokeShare({
        organizationId: orgId,
        projectId,
        credentialId,
        shareId,
        actor: { userId },
      })
    }

    it('the sharer and an admin or owner may revoke; the audit stays the machine user', async () => {
      const credentialId = await newCredential('actor-allowed')
      const mine = await hostCreate(credentialId, { ambientUserId: memberOne.userId })
      const result = await revokeAs(memberOne.userId, credentialId, mine.id)
      expect(result).toMatchObject({ status: 'ok', alreadyTerminal: false })

      for (const actor of [admin, owner]) {
        const share = await hostCreate(credentialId, { ambientUserId: memberOne.userId })
        await expect(revokeAs(actor.userId, credentialId, share.id)).resolves.toMatchObject({
          status: 'ok',
          alreadyTerminal: false,
        })
      }
      const revokedAudit = (await auditRows(SHARE_REVOKED)).filter(
        (row) => row.resourceId === mine.id
      )
      expect(revokedAudit.map((row) => row.actorType)).toEqual(['machine_user'])
    })

    it('a non-sharer member is rejected before any mutation or audit write', async () => {
      const credentialId = await newCredential('actor-denied')
      const share = await hostCreate(credentialId, { ambientUserId: memberOne.userId })
      const auditBefore = await auditCount(SHARE_REVOKED)

      await expect(revokeAs(memberTwo.userId, credentialId, share.id)).rejects.toBeInstanceOf(
        CredentialSharingNotAuthorizedError
      )
      expect((await shareRow(share.id)).status).toBe('active')
      expect(await auditCount(SHARE_REVOKED)).toBe(auditBefore)
    })

    it('a legacy host row with an unknown acting user is admin/owner only, even for the provisioner', async () => {
      const credentialId = await newCredential('actor-legacy')
      const share = await hostCreate(credentialId)
      await makeLegacy(share.id, memberOne.userId)

      await expect(revokeAs(memberOne.userId, credentialId, share.id)).rejects.toBeInstanceOf(
        CredentialSharingNotAuthorizedError
      )
      expect((await shareRow(share.id)).status).toBe('active')
      await expect(revokeAs(admin.userId, credentialId, share.id)).resolves.toMatchObject({
        status: 'ok',
      })
    })

    it('an actor outside the org gets the generic invalid error; a share of another org is not_found', async () => {
      const credentialId = await newCredential('actor-invalid')
      const share = await hostCreate(credentialId, { ambientUserId: memberOne.userId })
      await expect(revokeAs(foreignOwner.userId, credentialId, share.id)).rejects.toBeInstanceOf(
        CredentialSharingActingUserInvalidError
      )
      expect((await shareRow(share.id)).status).toBe('active')

      await expect(
        host.revokeShare({
          organizationId: orgId,
          projectId,
          credentialId,
          shareId: UNKNOWN_USER_ID,
          actor: { userId: admin.userId },
        })
      ).resolves.toEqual({ status: 'not_found' })
    })

    it('authorization comes before terminal state: an unauthorized actor is rejected, an authorized one gets the idempotent no-op', async () => {
      const credentialId = await newCredential('actor-terminal')
      const share = await hostCreate(credentialId, { ambientUserId: memberOne.userId })
      await revokeAs(memberOne.userId, credentialId, share.id)

      await expect(revokeAs(memberTwo.userId, credentialId, share.id)).rejects.toBeInstanceOf(
        CredentialSharingNotAuthorizedError
      )
      await expect(revokeAs(memberOne.userId, credentialId, share.id)).resolves.toMatchObject({
        status: 'ok',
        alreadyTerminal: true,
      })
    })

    it('without actor: unchanged behaviour (any share in the org may be revoked)', async () => {
      const credentialId = await newCredential('actor-none')
      const share = await hostCreate(credentialId, { ambientUserId: memberOne.userId })
      await expect(
        host.revokeShare({ organizationId: orgId, projectId, credentialId, shareId: share.id })
      ).resolves.toMatchObject({ status: 'ok', alreadyTerminal: false })
    })
  })
})
