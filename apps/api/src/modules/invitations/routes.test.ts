import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb, withOrg } from '@project-vault/db'
import { notificationQueue, projectInvitations, users } from '@project-vault/db/schema'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  createProjectViaApi as createProject,
  registerAndLoginViaApi,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import { bootProjectRouteTestApp } from '../projects/project-route-test-bootstrap.js'
import { generateInvitationToken, hashInvitationToken } from './tokens.js'

const { createApp, initVault } = await bootstrapRouteIntegrationTest()

type TestApp = Awaited<ReturnType<typeof createApp>>

const PASSWORD = 'correct-horse-battery-staple'
const MEMBER_ROLE = 'member'

function uniqueEmail(label: string): string {
  return `invitations-${label}-${randomUUID()}@example.com`
}

async function registerOwner(app: TestApp, label: string) {
  const user = await registerAndLoginViaApi(app, {
    email: uniqueEmail(label),
    password: PASSWORD,
    orgName: `Invitations ${label} ${randomUUID()}`,
  })
  await enrollMfa(user.userId)
  return user
}

async function enrollMfa(userId: string): Promise<void> {
  await getDb().update(users).set({ mfaEnrolledAt: new Date() }).where(eq(users.id, userId))
}

function invite(
  app: TestApp,
  cookies: Record<string, string>,
  projectId: string,
  body: { email: string; role: string }
) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/projects/${projectId}/invitations`,
    headers: { cookie: cookieHeader(cookies) },
    payload: body,
  })
}

async function inviteAndTokenize(
  app: TestApp,
  owner: { cookies: Record<string, string>; orgId: string },
  projectId: string,
  body: { email: string; role: string }
): Promise<{ invitationId: string; token: string }> {
  const created = await invite(app, owner.cookies, projectId, body)
  const invitationId = created.json<{ data: { id: string } }>().data.id
  const token = await tokenForInvitation(owner.orgId, invitationId)
  return { invitationId, token }
}

function listInvitations(app: TestApp, cookies: Record<string, string>, projectId: string) {
  return app.inject({
    method: 'GET',
    url: `/api/v1/projects/${projectId}/invitations`,
    headers: { cookie: cookieHeader(cookies) },
  })
}

function revokeInvitation(
  app: TestApp,
  cookies: Record<string, string>,
  projectId: string,
  id: string
) {
  return app.inject({
    method: 'DELETE',
    url: `/api/v1/projects/${projectId}/invitations/${id}`,
    headers: { cookie: cookieHeader(cookies) },
  })
}

function peekInvitation(app: TestApp, token: string) {
  return app.inject({ method: 'GET', url: `/api/v1/invitations/${token}` })
}

function acceptInvitation(app: TestApp, token: string, cookies?: Record<string, string>) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/invitations/${token}/accept`,
    headers: cookies ? { cookie: cookieHeader(cookies) } : undefined,
  })
}

function registerWithToken(
  app: TestApp,
  body: { email: string; password: string; invitationToken?: string; orgName?: string }
) {
  return app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: body })
}

async function insertRawInvitation(input: {
  orgId: string
  projectId: string
  email: string
  role: string
  invitedBy: string
  token: string
  expiresAt: Date
  acceptedAt?: Date | null
  revokedAt?: Date | null
}) {
  const [row] = await withOrg(input.orgId, (tx) =>
    tx
      .insert(projectInvitations)
      .values({
        orgId: input.orgId,
        projectId: input.projectId,
        email: input.email,
        roleToAssign: input.role,
        tokenHash: hashInvitationToken(input.token),
        invitedBy: input.invitedBy,
        expiresAt: input.expiresAt,
        acceptedAt: input.acceptedAt ?? null,
        revokedAt: input.revokedAt ?? null,
      })
      .returning()
  )
  if (!row) throw new Error('expected invitation row to be inserted')
  return row
}

async function expectInvitationAccepted(orgId: string, invitationId: string): Promise<void> {
  const [acceptedRow] = await withOrg(orgId, (tx) =>
    tx
      .select({ acceptedAt: projectInvitations.acceptedAt })
      .from(projectInvitations)
      .where(eq(projectInvitations.id, invitationId))
  )
  expect(acceptedRow?.acceptedAt).not.toBeNull()
}

describe.sequential('project invitation routes', () => {
  let app: TestApp

  beforeAll(async () => {
    app = await bootProjectRouteTestApp(createApp, initVault)
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  it('creates an invitation and enqueues the email (201), no token leaked', async () => {
    const owner = await registerOwner(app, 'create')
    const projectId = await createProject(app, owner.cookies, 'create-invite')
    const email = uniqueEmail('invitee')

    const res = await invite(app, owner.cookies, projectId, { email, role: MEMBER_ROLE })

    expect(res.statusCode).toBe(201)
    const body = res.json<{
      data: {
        id: string
        projectId: string
        email: string
        roleToAssign: string
        invitedBy: string
        expiresAt: string
      }
    }>()
    expect(body.data).toMatchObject({ projectId, email, roleToAssign: 'member' })
    expect(JSON.stringify(body)).not.toContain('token')

    const [queueRow] = await withOrg(owner.orgId, (tx) =>
      tx
        .select()
        .from(notificationQueue)
        .where(eq(notificationQueue.templateId, 'project.invitation_created'))
    )
    expect(queueRow?.recipientEmail).toBe(email)
    expect(queueRow?.recipientUserId).toBeNull()
  })

  it('blocks invite creation for an unenrolled owner (403 mfa_required), no row created', async () => {
    const owner = await registerAndLoginViaApi(app, {
      email: uniqueEmail('unenrolled'),
      password: PASSWORD,
      orgName: `Invitations unenrolled ${randomUUID()}`,
    })
    const projectId = await createProject(app, owner.cookies, 'unenrolled-invite')
    const email = uniqueEmail('blocked')

    const res = await invite(app, owner.cookies, projectId, { email, role: MEMBER_ROLE })

    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ code: 'mfa_required' })

    const rows = await withOrg(owner.orgId, (tx) =>
      tx.select().from(projectInvitations).where(eq(projectInvitations.email, email))
    )
    expect(rows).toHaveLength(0)
  })

  it('refreshes a pending duplicate invitation instead of creating a second row', async () => {
    const owner = await registerOwner(app, 'duplicate')
    const projectId = await createProject(app, owner.cookies, 'duplicate-invite')
    const email = uniqueEmail('duplicate-target')

    const first = await invite(app, owner.cookies, projectId, { email, role: 'viewer' })
    expect(first.statusCode).toBe(201)
    const second = await invite(app, owner.cookies, projectId, { email, role: 'admin' })
    expect(second.statusCode).toBe(201)

    const rows = await withOrg(owner.orgId, (tx) =>
      tx.select().from(projectInvitations).where(eq(projectInvitations.email, email))
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.roleToAssign).toBe('admin')
  })

  it('rejects inviting an existing project member with 409 already_member', async () => {
    const owner = await registerOwner(app, 'already-member')
    const projectId = await createProject(app, owner.cookies, 'already-member-invite')
    const ownerEmail = await getOwnerEmail(owner.userId)

    const res = await invite(app, owner.cookies, projectId, {
      email: ownerEmail,
      role: MEMBER_ROLE,
    })

    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'already_member' })
  })

  it('returns 404 project_not_found for a cross-org project id', async () => {
    const owner = await registerOwner(app, 'cross-org')
    const otherOwner = await registerOwner(app, 'cross-org-target')
    const otherProjectId = await createProject(app, otherOwner.cookies, 'cross-org-project')

    const res = await invite(app, owner.cookies, otherProjectId, {
      email: uniqueEmail('cross-org'),
      role: MEMBER_ROLE,
    })

    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ code: 'project_not_found' })
  })

  it('lists pending invitations without leaking the token', async () => {
    const owner = await registerOwner(app, 'list')
    const projectId = await createProject(app, owner.cookies, 'list-invite')
    const email = uniqueEmail('list-target')
    await invite(app, owner.cookies, projectId, { email, role: MEMBER_ROLE })

    const res = await listInvitations(app, owner.cookies, projectId)

    expect(res.statusCode).toBe(200)
    const body = res.json<{ data: { email: string }[] }>()
    expect(body.data.some((row) => row.email === email)).toBe(true)
    expect(JSON.stringify(body)).not.toContain('tokenHash')
  })

  it('revokes a pending invitation (204) and is idempotent on double-revoke', async () => {
    const owner = await registerOwner(app, 'revoke')
    const projectId = await createProject(app, owner.cookies, 'revoke-invite')
    const email = uniqueEmail('revoke-target')
    const created = await invite(app, owner.cookies, projectId, { email, role: MEMBER_ROLE })
    const invitationId = created.json<{ data: { id: string } }>().data.id

    const first = await revokeInvitation(app, owner.cookies, projectId, invitationId)
    expect(first.statusCode).toBe(204)

    const second = await revokeInvitation(app, owner.cookies, projectId, invitationId)
    expect(second.statusCode).toBe(204)
  })

  it('returns 404 revoking an unknown invitation id', async () => {
    const owner = await registerOwner(app, 'revoke-missing')
    const projectId = await createProject(app, owner.cookies, 'revoke-missing-invite')

    const res = await revokeInvitation(app, owner.cookies, projectId, randomUUID())

    expect(res.statusCode).toBe(404)
  })

  it('returns 409 revoking an already-accepted invitation', async () => {
    const owner = await registerOwner(app, 'revoke-accepted')
    const projectId = await createProject(app, owner.cookies, 'revoke-accepted-project')
    const row = await insertRawInvitation({
      orgId: owner.orgId,
      projectId,
      email: uniqueEmail('revoke-accepted-invitee'),
      role: MEMBER_ROLE,
      invitedBy: owner.userId,
      token: generateInvitationToken(),
      expiresAt: new Date(Date.now() + 60_000),
      acceptedAt: new Date(),
    })

    const res = await revokeInvitation(app, owner.cookies, projectId, row.id)

    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'already_accepted' })
  })

  describe('GET /api/v1/invitations/:token (peek)', () => {
    it('returns 404 for an unknown token', async () => {
      const res = await peekInvitation(app, generateInvitationToken())
      expect(res.statusCode).toBe(404)
      expect(res.json()).toMatchObject({ code: 'invitation_not_found' })
    })

    it('returns 410 for an expired invitation', async () => {
      const owner = await registerOwner(app, 'peek-expired')
      const projectId = await createProject(app, owner.cookies, 'peek-expired-project')
      const token = generateInvitationToken()
      await insertRawInvitation({
        orgId: owner.orgId,
        projectId,
        email: uniqueEmail('peek-expired-invitee'),
        role: MEMBER_ROLE,
        invitedBy: owner.userId,
        token,
        expiresAt: new Date(Date.now() - 1000),
      })

      const res = await peekInvitation(app, token)
      expect(res.statusCode).toBe(410)
      expect(res.json()).toMatchObject({ code: 'invitation_expired' })
    })

    it('returns 410 for a revoked invitation', async () => {
      const owner = await registerOwner(app, 'peek-revoked')
      const projectId = await createProject(app, owner.cookies, 'peek-revoked-project')
      const token = generateInvitationToken()
      await insertRawInvitation({
        orgId: owner.orgId,
        projectId,
        email: uniqueEmail('peek-revoked-invitee'),
        role: MEMBER_ROLE,
        invitedBy: owner.userId,
        token,
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: new Date(),
      })

      const res = await peekInvitation(app, token)
      expect(res.statusCode).toBe(410)
      expect(res.json()).toMatchObject({ code: 'invitation_revoked' })
    })

    it('returns 409 for an already-accepted invitation', async () => {
      const owner = await registerOwner(app, 'peek-accepted')
      const projectId = await createProject(app, owner.cookies, 'peek-accepted-project')
      const token = generateInvitationToken()
      await insertRawInvitation({
        orgId: owner.orgId,
        projectId,
        email: uniqueEmail('peek-accepted-invitee'),
        role: MEMBER_ROLE,
        invitedBy: owner.userId,
        token,
        expiresAt: new Date(Date.now() + 60_000),
        acceptedAt: new Date(),
      })

      const res = await peekInvitation(app, token)
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ code: 'invitation_already_accepted' })
    })

    it('returns accountExists=false for a brand-new invitee', async () => {
      const owner = await registerOwner(app, 'peek-new')
      const projectId = await createProject(app, owner.cookies, 'peek-new')
      const { token } = await inviteAndTokenize(app, owner, projectId, {
        email: uniqueEmail('peek-new-invitee'),
        role: MEMBER_ROLE,
      })

      const res = await peekInvitation(app, token)
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ data: { accountExists: false } })
    })

    it('returns accountExists=true for an invitee who already has an account', async () => {
      const owner = await registerOwner(app, 'peek-existing')
      const projectId = await createProject(app, owner.cookies, 'peek-existing')
      const jordan = await registerAndLoginViaApi(app, {
        email: uniqueEmail('peek-existing-invitee'),
        password: PASSWORD,
        orgName: `Jordan Org ${randomUUID()}`,
      })
      const jordanEmail = await getOwnerEmail(jordan.userId)
      const { token } = await inviteAndTokenize(app, owner, projectId, {
        email: jordanEmail,
        role: MEMBER_ROLE,
      })

      const res = await peekInvitation(app, token)
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ data: { accountExists: true } })
    })
  })

  describe('POST /api/v1/invitations/:token/accept', () => {
    it('returns 401 when unauthenticated', async () => {
      const res = await acceptInvitation(app, generateInvitationToken())
      expect(res.statusCode).toBe(401)
    })

    it('returns 403 when the logged-in user does not match the invited email', async () => {
      const owner = await registerOwner(app, 'accept-mismatch')
      const projectId = await createProject(app, owner.cookies, 'accept-mismatch')
      const { token } = await inviteAndTokenize(app, owner, projectId, {
        email: uniqueEmail('accept-mismatch-invitee'),
        role: MEMBER_ROLE,
      })

      const wrongUser = await registerAndLoginViaApi(app, {
        email: uniqueEmail('accept-mismatch-wrong'),
        password: PASSWORD,
        orgName: `Wrong User Org ${randomUUID()}`,
      })

      const res = await acceptInvitation(app, token, wrongUser.cookies)
      expect(res.statusCode).toBe(403)
      expect(res.json()).toMatchObject({ code: 'invitation_email_mismatch' })
    })

    it('joins the inviting project as the invited role for an existing user (200)', async () => {
      const owner = await registerOwner(app, 'accept-existing')
      const projectId = await createProject(app, owner.cookies, 'accept-existing')
      const inviteeEmail = uniqueEmail('accept-existing-invitee')
      const invitee = await registerAndLoginViaApi(app, {
        email: inviteeEmail,
        password: PASSWORD,
        orgName: `Invitee Org ${randomUUID()}`,
      })
      const { invitationId, token } = await inviteAndTokenize(app, owner, projectId, {
        email: inviteeEmail,
        role: 'viewer',
      })

      const res = await acceptInvitation(app, token, invitee.cookies)
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({
        data: { projectId, role: 'viewer' },
      })

      await expectInvitationAccepted(owner.orgId, invitationId)
    })

    it('cannot be consumed twice — a second accept returns 409, not a duplicate membership', async () => {
      const owner = await registerOwner(app, 'accept-twice')
      const projectId = await createProject(app, owner.cookies, 'accept-twice')
      const inviteeEmail = uniqueEmail('accept-twice-invitee')
      const invitee = await registerAndLoginViaApi(app, {
        email: inviteeEmail,
        password: PASSWORD,
        orgName: `Accept Twice Org ${randomUUID()}`,
      })
      const { token } = await inviteAndTokenize(app, owner, projectId, {
        email: inviteeEmail,
        role: MEMBER_ROLE,
      })

      const first = await acceptInvitation(app, token, invitee.cookies)
      expect(first.statusCode).toBe(200)

      const second = await acceptInvitation(app, token, invitee.cookies)
      expect(second.statusCode).toBe(409)
      expect(second.json()).toMatchObject({ code: 'invitation_already_accepted' })
    })
  })

  describe('POST /api/v1/auth/register with invitationToken (AC-4)', () => {
    it('joins the inviting org/project instead of creating a new org (201)', async () => {
      const owner = await registerOwner(app, 'register-new')
      const projectId = await createProject(app, owner.cookies, 'register-new')
      const inviteeEmail = uniqueEmail('register-new-invitee')
      const { invitationId, token } = await inviteAndTokenize(app, owner, projectId, {
        email: inviteeEmail,
        role: 'admin',
      })

      const res = await registerWithToken(app, {
        email: inviteeEmail,
        password: PASSWORD,
        invitationToken: token,
      })

      expect(res.statusCode).toBe(201)
      const body = res.json<{
        data: {
          orgId: string
          role: string
          invitedProject?: { projectId: string; projectName: string; role: string }
        }
      }>()
      expect(body.data.orgId).toBe(owner.orgId)
      expect(body.data.role).toBe('member')
      expect(body.data.invitedProject).toMatchObject({ projectId, role: 'admin' })

      await expectInvitationAccepted(owner.orgId, invitationId)
    })

    it('returns 404/410/410/409 for not-found/expired/revoked/already-accepted tokens', async () => {
      const owner = await registerOwner(app, 'register-taxonomy')
      const projectId = await createProject(app, owner.cookies, 'register-taxonomy')

      const notFound = await registerWithToken(app, {
        email: uniqueEmail('register-not-found'),
        password: PASSWORD,
        invitationToken: generateInvitationToken(),
      })
      expect(notFound.statusCode).toBe(404)
      expect(notFound.json()).toMatchObject({ code: 'invitation_not_found' })

      const expiredToken = generateInvitationToken()
      await insertRawInvitation({
        orgId: owner.orgId,
        projectId,
        email: uniqueEmail('register-expired'),
        role: MEMBER_ROLE,
        invitedBy: owner.userId,
        token: expiredToken,
        expiresAt: new Date(Date.now() - 1000),
      })
      const expired = await registerWithToken(app, {
        email: uniqueEmail('register-expired'),
        password: PASSWORD,
        invitationToken: expiredToken,
      })
      expect(expired.statusCode).toBe(410)
      expect(expired.json()).toMatchObject({ code: 'invitation_expired' })

      const revokedToken = generateInvitationToken()
      await insertRawInvitation({
        orgId: owner.orgId,
        projectId,
        email: uniqueEmail('register-revoked'),
        role: MEMBER_ROLE,
        invitedBy: owner.userId,
        token: revokedToken,
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: new Date(),
      })
      const revoked = await registerWithToken(app, {
        email: uniqueEmail('register-revoked'),
        password: PASSWORD,
        invitationToken: revokedToken,
      })
      expect(revoked.statusCode).toBe(410)
      expect(revoked.json()).toMatchObject({ code: 'invitation_revoked' })

      const acceptedToken = generateInvitationToken()
      await insertRawInvitation({
        orgId: owner.orgId,
        projectId,
        email: uniqueEmail('register-already-accepted'),
        role: MEMBER_ROLE,
        invitedBy: owner.userId,
        token: acceptedToken,
        expiresAt: new Date(Date.now() + 60_000),
        acceptedAt: new Date(),
      })
      const alreadyAccepted = await registerWithToken(app, {
        email: uniqueEmail('register-already-accepted'),
        password: PASSWORD,
        invitationToken: acceptedToken,
      })
      expect(alreadyAccepted.statusCode).toBe(409)
      expect(alreadyAccepted.json()).toMatchObject({ code: 'invitation_already_accepted' })
    })

    it('returns 422 when the registration email does not match the invited email', async () => {
      const owner = await registerOwner(app, 'register-mismatch')
      const projectId = await createProject(app, owner.cookies, 'register-mismatch')
      const { token } = await inviteAndTokenize(app, owner, projectId, {
        email: uniqueEmail('register-mismatch-invitee'),
        role: MEMBER_ROLE,
      })

      const res = await registerWithToken(app, {
        email: uniqueEmail('register-mismatch-someone-else'),
        password: PASSWORD,
        invitationToken: token,
      })

      expect(res.statusCode).toBe(422)
      expect(res.json()).toMatchObject({ code: 'invitation_email_mismatch' })
    })

    it('returns 409 email_taken when the invited address already has an account', async () => {
      const owner = await registerOwner(app, 'register-existing-email')
      const projectId = await createProject(app, owner.cookies, 'register-existing-email')
      const existingEmail = uniqueEmail('register-existing')
      await registerAndLoginViaApi(app, {
        email: existingEmail,
        password: PASSWORD,
        orgName: `Existing Org ${randomUUID()}`,
      })
      const { token } = await inviteAndTokenize(app, owner, projectId, {
        email: existingEmail,
        role: MEMBER_ROLE,
      })

      const res = await registerWithToken(app, {
        email: existingEmail,
        password: PASSWORD,
        invitationToken: token,
      })

      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ code: 'email_taken' })
    })

    it('still requires orgName when no invitationToken is provided (unchanged behavior)', async () => {
      const res = await registerWithToken(app, {
        email: uniqueEmail('register-no-invite-no-org'),
        password: PASSWORD,
      })
      expect(res.statusCode).toBe(422)
    })
  })
})

async function getOwnerEmail(userId: string): Promise<string> {
  const [row] = await getDb().select({ email: users.email }).from(users).where(eq(users.id, userId))
  if (!row) throw new Error('expected user row')
  return row.email
}

async function tokenForInvitation(orgId: string, invitationId: string): Promise<string> {
  // Test-only shortcut: mint a fresh token and overwrite the stored hash so the test can
  // exercise the real peek/accept endpoints against a known plaintext token.
  const token = generateInvitationToken()
  await withOrg(orgId, (tx) =>
    tx
      .update(projectInvitations)
      .set({ tokenHash: hashInvitationToken(token) })
      .where(eq(projectInvitations.id, invitationId))
  )
  return token
}
