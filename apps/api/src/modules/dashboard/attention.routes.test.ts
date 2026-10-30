import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import {
  certRecords,
  credentialShares,
  projectInvitations,
  projects,
} from '@project-vault/db/schema'
import {
  ATTENTION_ITEMS_PER_KIND,
  type AttentionItem,
  type DashboardAttention,
} from '@project-vault/shared'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { createMembershipTestHelpers } from '../../__tests__/helpers/membership-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import {
  bootCredentialRouteApp,
  createCredentialTestProject,
  createCredentialViaApi,
} from '../credentials/credential-route-test-helpers.js'

const MAIL_DOMAIN = 'team.test'

const { createApp, initVault } = await bootstrapRouteIntegrationTest()

type TestApp = Awaited<ReturnType<typeof createApp>>
type Cookies = { cookies: Record<string, string> }

const { addUserToOrg, registerOwner, addProjectMember } = createMembershipTestHelpers({
  emailPrefix: 'attention',
  orgNamePrefix: 'Attention Org',
})

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function inMs(ms: number): Date {
  return new Date(Date.now() + ms)
}

describe('GET /api/v1/dashboard/attention (story 72-12)', () => {
  let app: TestApp

  beforeAll(async () => {
    await resetVaultForTest()
    app = await bootCredentialRouteApp(createApp, initVault, 'attention-passphrase')
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  function getAttention(actor: Cookies) {
    return app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/attention',
      headers: { cookie: cookieHeader(actor.cookies) },
    })
  }

  async function attentionOf(actor: Cookies): Promise<DashboardAttention> {
    const response = await getAttention(actor)
    expect(response.statusCode).toBe(200)
    return response.json<{ data: DashboardAttention }>().data
  }

  async function shareWith(
    sharer: Cookies,
    projectId: string,
    credentialId: string,
    recipientUserId: string
  ): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/credentials/${credentialId}/shares`,
      headers: { cookie: cookieHeader(sharer.cookies) },
      payload: { recipientUserId, expiresAt: inMs(HOUR).toISOString() },
    })
    expect(response.statusCode).toBe(201)
    const id = response.json<{ data: { id: string } }>().data.id
    return id
  }

  async function setShareExpiry(orgId: string, shareId: string, expiresAt: Date) {
    await withOrg(orgId, (tx) =>
      tx.update(credentialShares).set({ expiresAt }).where(eq(credentialShares.id, shareId))
    )
  }

  async function addCertificate(
    orgId: string,
    projectId: string,
    domain: string,
    expiresAt: Date | null
  ): Promise<string> {
    const [row] = await withOrg(orgId, (tx) =>
      tx.insert(certRecords).values({ orgId, projectId, domain, expiresAt }).returning()
    )
    return (row as { id: string }).id
  }

  async function addInvitation(
    orgId: string,
    projectId: string,
    invitedBy: string,
    opts: {
      email: string
      expiresAt?: Date
      acceptedAt?: Date
      revokedAt?: Date
    }
  ): Promise<string> {
    const [row] = await withOrg(orgId, (tx) =>
      tx
        .insert(projectInvitations)
        .values({
          orgId,
          projectId,
          email: opts.email,
          roleToAssign: 'member',
          tokenHash: randomUUID(),
          invitedBy,
          expiresAt: opts.expiresAt ?? inMs(3 * DAY),
          acceptedAt: opts.acceptedAt ?? null,
          revokedAt: opts.revokedAt ?? null,
        })
        .returning()
    )
    return (row as { id: string }).id
  }

  /** One org with every role and every kind of item; ids are returned by purpose. */
  async function seedOrg(label: string) {
    const owner = await registerOwner(app, `${label}-owner`)
    const admin = await addUserToOrg(app, owner.orgId, `${label}-admin`, { orgRole: 'admin' })
    const sharer = await addUserToOrg(app, owner.orgId, `${label}-sharer`, { orgRole: 'member' })
    const peer = await addUserToOrg(app, owner.orgId, `${label}-peer`, { orgRole: 'member' })
    const outside = await addUserToOrg(app, owner.orgId, `${label}-outside`, { orgRole: 'member' })
    const viewer = await addUserToOrg(app, owner.orgId, `${label}-viewer`, { orgRole: 'viewer' })
    const p1 = await createCredentialTestProject(app, owner.cookies, `${label}-p1`)
    const p2 = await createCredentialTestProject(app, owner.cookies, `${label}-p2`)
    await addProjectMember(owner.orgId, p1, sharer.userId, 'member')
    await addProjectMember(owner.orgId, p1, peer.userId, 'member')
    const c1 = (await createCredentialViaApi(app, owner.cookies, p1)).id
    const c2 = (await createCredentialViaApi(app, owner.cookies, p2)).id

    const sharerShare = await shareWith(sharer, p1, c1, owner.userId)
    const ownerShareP1 = await shareWith(owner, p1, c1, sharer.userId)
    const ownerShareP2 = await shareWith(owner, p2, c2, admin.userId)
    await setShareExpiry(owner.orgId, sharerShare, inMs(2 * DAY))
    await setShareExpiry(owner.orgId, ownerShareP1, inMs(3 * DAY))
    await setShareExpiry(owner.orgId, ownerShareP2, inMs(4 * DAY))

    const certP1 = await addCertificate(owner.orgId, p1, 'p1.example', inMs(10 * DAY))
    const certP1Expired = await addCertificate(owner.orgId, p1, 'old.example', inMs(-2 * DAY))
    const certP2 = await addCertificate(owner.orgId, p2, 'p2.example', inMs(5 * DAY))

    const invP1 = await addInvitation(owner.orgId, p1, owner.userId, {
      email: `i1-${label}@x.test`,
    })
    const invP2 = await addInvitation(owner.orgId, p2, owner.userId, {
      email: `i2-${label}@x.test`,
    })

    return {
      owner,
      admin,
      sharer,
      peer,
      outside,
      viewer,
      p1,
      p2,
      c1,
      c2,
      shares: { sharerShare, ownerShareP1, ownerShareP2 },
      certs: { certP1, certP1Expired, certP2 },
      invs: { invP1, invP2 },
    }
  }

  const ids = (data: DashboardAttention) => data.items.map((item) => item.id).sort()

  it('(b) answers each role the list its existing routes allow', async () => {
    const f = await seedOrg('roles')
    const all = [
      ...Object.values(f.shares),
      ...Object.values(f.certs),
      ...Object.values(f.invs),
    ].sort()

    expect(ids(await attentionOf(f.owner))).toEqual(all)
    expect(ids(await attentionOf(f.admin))).toEqual(all)

    const sharer = await attentionOf(f.sharer)
    expect(ids(sharer)).toEqual(
      [f.shares.sharerShare, f.certs.certP1, f.certs.certP1Expired].sort()
    )
    expect(sharer.counts).toEqual({
      expiringShares: 1,
      expiringCertificates: 2,
      pendingInvitations: 0,
    })

    const peer = await attentionOf(f.peer)
    expect(ids(peer)).toEqual([f.certs.certP1, f.certs.certP1Expired].sort())

    expect(await attentionOf(f.outside)).toEqual({
      items: [],
      counts: { expiringShares: 0, expiringCertificates: 0, pendingInvitations: 0 },
    })
  })

  it('answers an org viewer 200 with an empty list, never 403', async () => {
    const f = await seedOrg('viewer')
    const response = await getAttention(f.viewer)
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      data: {
        items: [],
        counts: { expiringShares: 0, expiringCertificates: 0, pendingInvitations: 0 },
      },
    })
  })

  it('requires a session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/dashboard/attention' })
    expect(response.statusCode).toBe(401)
  })

  it('(a) never shows or counts another organization item of any kind', async () => {
    const a = await seedOrg('tenant-a')
    const b = await seedOrg('tenant-b')
    const bAll = [
      ...Object.values(b.shares),
      ...Object.values(b.certs),
      ...Object.values(b.invs),
    ].sort()
    const aAll = [
      ...Object.values(a.shares),
      ...Object.values(a.certs),
      ...Object.values(a.invs),
    ].sort()

    const forA = await attentionOf(a.owner)
    expect(ids(forA)).toEqual(aAll)
    expect(forA.counts).toEqual({
      expiringShares: 3,
      expiringCertificates: 3,
      pendingInvitations: 2,
    })
    expect(ids(await attentionOf(b.owner))).toEqual(bAll)
    expect(JSON.stringify(forA)).not.toContain(b.p1)
  })

  it('(c) equals the union of what the existing list routes return for the caller', async () => {
    const f = await seedOrg('compare')
    const archivedProject = await createCredentialTestProject(app, f.owner.cookies, 'compare-arch')
    const archivedCredential = (await createCredentialViaApi(app, f.owner.cookies, archivedProject))
      .id
    const archivedShare = await shareWith(
      f.owner,
      archivedProject,
      archivedCredential,
      f.admin.userId
    )
    await setShareExpiry(f.owner.orgId, archivedShare, inMs(DAY))
    await addCertificate(f.owner.orgId, archivedProject, 'arch.example', inMs(DAY))
    const lockedShare = await shareWith(f.owner, f.p1, f.c1, f.sharer.userId)
    await withOrg(f.owner.orgId, (tx) =>
      tx
        .update(credentialShares)
        .set({ expiresAt: inMs(DAY), lockedAt: new Date() })
        .where(eq(credentialShares.id, lockedShare))
    )
    const expiredShare = await shareWith(f.owner, f.p2, f.c2, f.sharer.userId)
    await setShareExpiry(f.owner.orgId, expiredShare, inMs(-HOUR))
    await withOrg(f.owner.orgId, (tx) =>
      tx.update(projects).set({ archivedAt: new Date() }).where(eq(projects.id, archivedProject))
    )
    const archivedProjectIds = new Set([archivedProject])
    const excludedShareIds = new Set([archivedShare, lockedShare, expiredShare])

    const get = async (actor: Cookies, url: string) =>
      app.inject({ method: 'GET', url, headers: { cookie: cookieHeader(actor.cookies) } })
    type Dated = { id: string; expiresAt: string | null }
    const within = (rows: Dated[], days: number) =>
      rows
        .filter((row) => row.expiresAt && Date.parse(row.expiresAt) <= Date.now() + days * DAY)
        .map((row) => row.id)

    async function listedForProject(actor: Cookies, projectId: string, isAdmin: boolean) {
      const certs = await get(actor, `/api/v1/projects/${projectId}/certificates`)
      const out = within(certs.json<{ data: { items: Dated[] } }>().data.items, 30)
      if (!isAdmin) return out
      const invitations = await get(actor, `/api/v1/projects/${projectId}/invitations`)
      return [...out, ...invitations.json<{ data: Array<{ id: string }> }>().data.map((i) => i.id)]
    }

    async function listed(actor: Cookies, isAdmin: boolean): Promise<string[]> {
      const index = await get(actor, '/api/v1/shares?status=active&limit=100')
      const activeShares = index
        .json<{ data: { items: Dated[] } }>()
        .data.items.filter((share) => !excludedShareIds.has(share.id))
      const out = within(activeShares, 7)
      // The project list is the access-controlled source of projects (a member only lists projects
      // they belong to); the per-project certificate route itself only checks the org role.
      const visible = await get(actor, '/api/v1/projects')
      const liveProjects = visible
        .json<{ data: { items: Array<{ id: string }> } }>()
        .data.items.filter((project) => !archivedProjectIds.has(project.id))
      for (const project of liveProjects) {
        out.push(...(await listedForProject(actor, project.id, isAdmin)))
      }
      return out.sort()
    }

    const callers: Array<[string, Cookies, boolean]> = [
      ['owner', f.owner, true],
      ['admin', f.admin, true],
      ['sharer', f.sharer, false],
      ['peer', f.peer, false],
      ['outside', f.outside, false],
    ]
    for (const [name, actor, isAdmin] of callers) {
      expect(ids(await attentionOf(actor)), name).toEqual(await listed(actor, isAdmin))
    }
  })

  it('(d) honours the share, certificate and invitation boundaries', async () => {
    const owner = await registerOwner(app, 'bounds-owner')
    const project = await createCredentialTestProject(app, owner.cookies, 'bounds')
    const credential = (await createCredentialViaApi(app, owner.cookies, project)).id
    const recipient = await addUserToOrg(app, owner.orgId, 'bounds-recipient')

    const shareIds = new Map<string, string>()
    for (const [name, expiresInMs] of [
      ['in', 6 * DAY + 23 * HOUR],
      ['out', 7 * DAY + HOUR],
      ['expired', -HOUR],
    ] as const) {
      const id = await shareWith(owner, project, credential, recipient.userId)
      await setShareExpiry(owner.orgId, id, inMs(expiresInMs))
      shareIds.set(name, id)
    }
    const shareIn = shareIds.get('in') as string
    const lockedShare = await shareWith(owner, project, credential, recipient.userId)
    await withOrg(owner.orgId, (tx) =>
      tx
        .update(credentialShares)
        .set({ expiresAt: inMs(DAY), lockedAt: new Date() })
        .where(eq(credentialShares.id, lockedShare))
    )

    const certIn = await addCertificate(owner.orgId, project, 'in.example', inMs(30 * DAY - MINUTE))
    await addCertificate(owner.orgId, project, 'out.example', inMs(30 * DAY + MINUTE))
    await addCertificate(owner.orgId, project, 'none.example', null)
    const certExpired = await addCertificate(owner.orgId, project, 'gone.example', inMs(-DAY))

    const invPending = await addInvitation(owner.orgId, project, owner.userId, {
      email: `pending@${MAIL_DOMAIN}`,
    })
    await addInvitation(owner.orgId, project, owner.userId, {
      email: `revoked@${MAIL_DOMAIN}`,
      revokedAt: new Date(),
    })
    await addInvitation(owner.orgId, project, owner.userId, {
      email: `accepted@${MAIL_DOMAIN}`,
      acceptedAt: new Date(),
    })
    await addInvitation(owner.orgId, project, owner.userId, {
      email: `expired@${MAIL_DOMAIN}`,
      expiresAt: inMs(-HOUR),
    })

    const result = await attentionOf(owner)
    expect(ids(result)).toEqual([shareIn, certIn, certExpired, invPending].sort())
    expect(result.counts).toEqual({
      expiringShares: 1,
      expiringCertificates: 2,
      pendingInvitations: 1,
    })
    const byId = new Map<string, AttentionItem>(result.items.map((item) => [item.id, item]))
    expect(byId.get(certExpired)).toMatchObject({ kind: 'expiring_certificate', expired: true })
    expect(byId.get(certIn)).toMatchObject({ kind: 'expiring_certificate', expired: false })
    expect(byId.get(invPending)).toMatchObject({
      kind: 'pending_invitation',
      email: `pending@${MAIL_DOMAIN}`,
    })
    expect(byId.get(shareIn)).toMatchObject({
      kind: 'expiring_share',
      credentialId: credential,
      projectId: project,
    })
  })

  it('orders by due date and caps each kind at ten while counting the true total', async () => {
    const owner = await registerOwner(app, 'cap-owner')
    const project = await createCredentialTestProject(app, owner.cookies, 'cap')
    const total = ATTENTION_ITEMS_PER_KIND + 2
    for (let i = 0; i < total; i += 1) {
      await addCertificate(owner.orgId, project, `c${i}.example`, inMs((i + 1) * DAY))
    }
    const result = await attentionOf(owner)
    expect(result.items).toHaveLength(ATTENTION_ITEMS_PER_KIND)
    expect(result.counts.expiringCertificates).toBe(total)
    const due = result.items.map((item) => Date.parse(item.dueAt))
    expect(due).toEqual([...due].sort((x, y) => x - y))
    // The two furthest certificates are the ones the cap drops.
    expect(
      result.items.map((item) => (item.kind === 'expiring_certificate' ? item.domain : ''))
    ).not.toContain(`c${total - 1}.example`)
  })

  it('leaves out a soft-deleted and an archived project', async () => {
    const owner = await registerOwner(app, 'gone-owner')
    const alive = await createCredentialTestProject(app, owner.cookies, 'alive')
    const gone = await createCredentialTestProject(app, owner.cookies, 'gone')
    const archived = await createCredentialTestProject(app, owner.cookies, 'archived')
    let aliveShare = ''
    const aliveCert = await addCertificate(owner.orgId, alive, 'alive.example', inMs(DAY))
    await addCertificate(owner.orgId, gone, 'gone.example', inMs(DAY))
    await addCertificate(owner.orgId, archived, 'archived.example', inMs(DAY))
    const credential = (await createCredentialViaApi(app, owner.cookies, alive)).id
    const goneCredential = (await createCredentialViaApi(app, owner.cookies, gone)).id
    const archivedCredential = (await createCredentialViaApi(app, owner.cookies, archived)).id
    const recipient = await addUserToOrg(app, owner.orgId, 'gone-recipient')
    for (const [projectId, credentialId] of [
      [alive, credential],
      [gone, goneCredential],
      [archived, archivedCredential],
    ] as const) {
      const shareId = await shareWith(owner, projectId, credentialId, recipient.userId)
      await setShareExpiry(owner.orgId, shareId, inMs(DAY))
      if (projectId === alive) aliveShare = shareId
    }
    await addInvitation(owner.orgId, gone, owner.userId, { email: `gone@${MAIL_DOMAIN}` })
    await addInvitation(owner.orgId, archived, owner.userId, { email: `archived@${MAIL_DOMAIN}` })
    await withOrg(owner.orgId, async (tx) => {
      await tx.update(projects).set({ deletedAt: new Date() }).where(eq(projects.id, gone))
      await tx.update(projects).set({ archivedAt: new Date() }).where(eq(projects.id, archived))
    })
    const result = await attentionOf(owner)
    expect(ids(result)).toEqual([aliveShare, aliveCert].sort())
    expect(result.counts).toEqual({
      expiringShares: 1,
      expiringCertificates: 1,
      pendingInvitations: 0,
    })
  })
})
