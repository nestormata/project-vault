import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { credentialShares, projectMemberships } from '@project-vault/db/schema'
import { SHARE_ERROR_REASONS } from '@project-vault/shared'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
} from '../../__tests__/helpers/auth-test-helpers.js'
import {
  createMembershipTestHelpers,
  MEMBERSHIP_TEST_LOGIN_SECRET,
} from '../../__tests__/helpers/membership-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import {
  bootCredentialRouteApp,
  createCredentialTestProject,
  createCredentialViaApi,
} from '../credentials/credential-route-test-helpers.js'

const VENDOR_DOMAIN = 'vendor.example'

const { createApp, initVault } = await bootstrapRouteIntegrationTest()

type TestApp = Awaited<ReturnType<typeof createApp>>

const { addUserToOrg, registerOwner, addProjectMember } = createMembershipTestHelpers({
  emailPrefix: 'shares-index',
  orgNamePrefix: 'Shares Index Org',
})

type ErrorBody = { code: string; reason?: string }
type Cookies = { cookies: Record<string, string> }

function futureIso(ms = 60 * 60 * 1000): string {
  return new Date(Date.now() + ms).toISOString()
}

describe('shares index, display status and typed reasons', () => {
  let app: TestApp

  beforeAll(async () => {
    await resetVaultForTest()
    app = await bootCredentialRouteApp(createApp, initVault, 'shares-index-passphrase')
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  async function createFixture(label: string) {
    const owner = await registerOwner(app, `${label}-owner`)
    const member = await addUserToOrg(app, owner.orgId, `${label}-member`, { orgRole: 'member' })
    const other = await addUserToOrg(app, owner.orgId, `${label}-other`, { orgRole: 'member' })
    const projectId = await createCredentialTestProject(app, owner.cookies, label)
    await addProjectMember(owner.orgId, projectId, member.userId, 'member')
    const credential = await createCredentialViaApi(app, owner.cookies, projectId)
    return { owner, member, other, projectId, credentialId: credential.id }
  }

  function shareUrl(projectId: string, credentialId: string, suffix = '') {
    return `/api/v1/projects/${projectId}/credentials/${credentialId}/shares${suffix}`
  }

  function createShare(
    actor: Cookies,
    projectId: string,
    credentialId: string,
    body: Record<string, unknown>,
    kind: 'shares' | 'external-shares' = 'shares'
  ) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/credentials/${credentialId}/${kind}`,
      headers: { cookie: cookieHeader(actor.cookies) },
      payload: body,
    })
  }

  async function shareWith(
    sharer: Cookies,
    projectId: string,
    credentialId: string,
    recipientUserId: string
  ): Promise<string> {
    const response = await createShare(sharer, projectId, credentialId, {
      recipientUserId,
      expiresAt: futureIso(),
    })
    expect(response.statusCode).toBe(201)
    return response.json<{ data: { id: string } }>().data.id
  }

  function getIndex(actor: Cookies, query = '') {
    return app.inject({
      method: 'GET',
      url: `/api/v1/shares${query}`,
      headers: { cookie: cookieHeader(actor.cookies) },
    })
  }

  type IndexBody = {
    data: {
      total: number
      items: Array<{
        id: string
        credentialName: string
        projectId: string
        projectName: string
        displayStatus: string
        status: string
        lockedAt: string | null
      }>
    }
  }

  async function patchShare(
    orgId: string,
    shareId: string,
    set: Partial<typeof credentialShares.$inferInsert>
  ) {
    await withOrg(orgId, (tx) =>
      tx.update(credentialShares).set(set).where(eq(credentialShares.id, shareId))
    )
  }

  it('returns a reason from the closed enum next to the unchanged code', async () => {
    const { owner, projectId, credentialId } = await createFixture('reasons-set')
    const response = await createShare(owner, projectId, credentialId, {
      recipientUserId: owner.userId,
      expiresAt: futureIso(),
    })
    expect(response.statusCode).toBe(400)
    const body = response.json<ErrorBody>()
    expect(body.code).toBe('self_share')
    expect(SHARE_ERROR_REASONS).toContain(body.reason)
  })

  it('adds displayStatus, lockedAt and verificationRequired to the create response', async () => {
    const { owner, member, projectId, credentialId } = await createFixture('summary')
    const response = await createShare(owner, projectId, credentialId, {
      recipientUserId: member.userId,
      expiresAt: futureIso(),
    })
    expect(response.statusCode).toBe(201)
    expect(response.json<{ data: Record<string, unknown> }>().data).toMatchObject({
      status: 'active',
      displayStatus: 'active',
      lockedAt: null,
      verificationRequired: false,
    })
  })

  it('external create is gated and revoke returns the new fields', async () => {
    const { owner, projectId, credentialId } = await createFixture('external-summary')
    const created = await createShare(
      owner,
      projectId,
      credentialId,
      {
        recipientEmail: `guest@${VENDOR_DOMAIN}`,
        expiresAt: futureIso(),
        password: MEMBERSHIP_TEST_LOGIN_SECRET,
      },
      'external-shares'
    )
    expect(created.statusCode).toBe(201)
    const data = created.json<{ data: { id: string; verificationRequired: boolean } }>().data
    expect(data.verificationRequired).toBe(true)

    const revoked = await app.inject({
      method: 'POST',
      url: shareUrl(projectId, credentialId, `/${data.id}/revoke`),
      headers: { cookie: cookieHeader(owner.cookies) },
    })
    expect(revoked.statusCode).toBe(200)
    expect(revoked.json<{ data: Record<string, unknown> }>().data).toMatchObject({
      status: 'revoked',
      displayStatus: 'revoked',
      verificationRequired: true,
    })
  })

  it('revoke by a non-sharer member answers 403 insufficient_role with reason revoke_forbidden', async () => {
    const { owner, member, other, projectId, credentialId } = await createFixture('revoke-denied')
    await addProjectMember(owner.orgId, projectId, other.userId, 'member')
    const shareId = await shareWith(member, projectId, credentialId, owner.userId)

    const response = await app.inject({
      method: 'POST',
      url: shareUrl(projectId, credentialId, `/${shareId}/revoke`),
      headers: { cookie: cookieHeader(other.cookies) },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json<ErrorBody>()).toMatchObject({
      code: 'insufficient_role',
      reason: 'revoke_forbidden',
    })
  })

  it('never adds a reason for an actor who cannot see the project (404, no reason)', async () => {
    const { owner, member, other, projectId, credentialId } = await createFixture('invisible')
    const shareId = await shareWith(member, projectId, credentialId, owner.userId)

    const create = await createShare(other, projectId, credentialId, {
      recipientUserId: owner.userId,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      fieldKey: 'nope',
    })
    const external = await createShare(
      other,
      projectId,
      credentialId,
      {
        recipientEmail: `guest@${VENDOR_DOMAIN}`,
        expiresAt: futureIso(),
        password: MEMBERSHIP_TEST_LOGIN_SECRET,
        singleUse: false,
      },
      'external-shares'
    )
    const revoke = await app.inject({
      method: 'POST',
      url: shareUrl(projectId, credentialId, `/${shareId}/revoke`),
      headers: { cookie: cookieHeader(other.cookies) },
    })
    for (const response of [create, external, revoke]) {
      expect(response.statusCode).toBe(404)
      expect(response.json<ErrorBody>().reason).toBeUndefined()
    }
  })

  it('GET /api/v1/shares: a member sees only own shares, an admin sees all, newest first', async () => {
    const { owner, member, projectId, credentialId } = await createFixture('index-scope')
    const memberShare = await shareWith(member, projectId, credentialId, owner.userId)
    const ownerShare = await shareWith(owner, projectId, credentialId, member.userId)

    const asMember = (await getIndex(member)).json<IndexBody>()
    expect(asMember.data.items.map((i) => i.id)).toEqual([memberShare])
    expect(asMember.data.total).toBe(1)
    expect(asMember.data.items[0]).toMatchObject({ projectId, displayStatus: 'active' })
    expect(asMember.data.items[0]?.credentialName).toEqual(expect.any(String))
    expect(asMember.data.items[0]?.projectName).toEqual(expect.any(String))

    const asOwner = (await getIndex(owner)).json<IndexBody>()
    expect(asOwner.data.items.map((i) => i.id)).toEqual([ownerShare, memberShare])
    expect(asOwner.data.total).toBe(2)
  })

  it('GET /api/v1/shares: omits rows in a project the member can no longer see', async () => {
    const { owner, member, projectId, credentialId } = await createFixture('index-hidden')
    await shareWith(member, projectId, credentialId, owner.userId)
    expect((await getIndex(member)).json<IndexBody>().data.total).toBe(1)

    await withOrg(owner.orgId, (tx) =>
      tx
        .delete(projectMemberships)
        .where(
          and(
            eq(projectMemberships.projectId, projectId),
            eq(projectMemberships.userId, member.userId)
          )
        )
    )
    const hidden = await getIndex(member)
    expect(hidden.statusCode).toBe(200)
    expect(hidden.json<IndexBody>().data).toEqual({ items: [], total: 0 })
    expect(hidden.body).not.toContain('credentialName')
    expect((await getIndex(owner)).json<IndexBody>().data.total).toBe(1)
  })

  it('GET /api/v1/shares: filters by status and displayStatus (opened, locked, expired)', async () => {
    const { owner, member, projectId, credentialId } = await createFixture('index-filters')
    const ids = {
      active: await shareWith(owner, projectId, credentialId, member.userId),
      viewed: await shareWith(owner, projectId, credentialId, member.userId),
      multi: await shareWith(owner, projectId, credentialId, member.userId),
      locked: await shareWith(owner, projectId, credentialId, member.userId),
      expired: await shareWith(owner, projectId, credentialId, member.userId),
    }
    await patchShare(owner.orgId, ids.viewed, { status: 'viewed', viewCount: 1 })
    await patchShare(owner.orgId, ids.multi, { singleUse: false, viewCount: 2 })
    await patchShare(owner.orgId, ids.locked, {
      status: 'revoked',
      revokedAt: new Date(),
      lockedAt: new Date(),
    })
    await patchShare(owner.orgId, ids.expired, { status: 'expired' })

    async function idsFor(query: string) {
      const body = (await getIndex(owner, query)).json<IndexBody>()
      return { ids: body.data.items.map((i) => i.id).sort(), total: body.data.total }
    }
    expect(await idsFor('?displayStatus=active')).toEqual({ ids: [ids.active], total: 1 })
    expect(await idsFor('?displayStatus=opened')).toEqual({
      ids: [ids.viewed, ids.multi].sort(),
      total: 2,
    })
    expect(await idsFor('?displayStatus=locked')).toEqual({ ids: [ids.locked], total: 1 })
    expect(await idsFor('?displayStatus=revoked')).toEqual({ ids: [], total: 0 })
    expect(await idsFor('?displayStatus=expired')).toEqual({ ids: [ids.expired], total: 1 })
    expect(await idsFor('?status=revoked')).toEqual({ ids: [ids.locked], total: 1 })
    expect(await idsFor('?status=viewed&displayStatus=opened')).toEqual({
      ids: [ids.viewed],
      total: 1,
    })

    const all = (await getIndex(owner)).json<IndexBody>().data.items
    const lockedItem = all.find((i) => i.id === ids.locked)
    expect(lockedItem).toMatchObject({ displayStatus: 'locked', status: 'revoked' })
    expect(lockedItem?.lockedAt).toEqual(expect.any(String))

    const perCredential = await app.inject({
      method: 'GET',
      url: shareUrl(projectId, credentialId, '?displayStatus=locked'),
      headers: { cookie: cookieHeader(owner.cookies) },
    })
    const listed = perCredential.json<IndexBody>()
    expect(listed.data.items.map((i) => i.id)).toEqual([ids.locked])
    expect(listed.data.total).toBe(1)
  })

  it('GET /api/v1/shares: pages with offset, clamps limit, rejects a bad filter', async () => {
    const { owner, member, projectId, credentialId } = await createFixture('index-paging')
    await Promise.all([0, 1, 2].map(() => shareWith(owner, projectId, credentialId, member.userId)))
    const page = (await getIndex(owner, '?limit=2&offset=1')).json<IndexBody>()
    expect(page.data.items).toHaveLength(2)
    expect(page.data.total).toBe(3)
    expect((await getIndex(owner, '?limit=100000')).statusCode).toBe(200)
    expect((await getIndex(owner, '?displayStatus=bogus')).statusCode).toBe(422)
    expect((await getIndex(owner, `?status=${randomUUID()}`)).statusCode).toBe(422)
  })

  it('GET /api/v1/shares: requires a session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/shares' })
    expect(response.statusCode).toBe(401)
  })

  it('GET /api/v1/shares: another org never appears', async () => {
    const a = await createFixture('index-org-a')
    await shareWith(a.owner, a.projectId, a.credentialId, a.member.userId)
    const b = await registerOwner(app, 'index-org-b-owner')
    expect((await getIndex(b)).json<IndexBody>().data).toEqual({ items: [], total: 0 })
  })
})
