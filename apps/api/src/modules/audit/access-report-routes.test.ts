import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb, withOrg } from '@project-vault/db'
import {
  auditLogEntries,
  orgMemberships,
  projectInvitations,
  userIdentityTokens,
  users,
} from '@project-vault/db/schema'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  createProjectViaApi,
  initVaultForTest,
  registerAndLoginViaApi,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { createTestUser, withTwoTestOrgs } from '@project-vault/db/test-helpers'
import { createMembershipTestHelpers } from '../../__tests__/helpers/membership-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import { generateInvitationToken, hashInvitationToken } from '../invitations/tokens.js'

const { createApp, initVault } = await bootstrapRouteIntegrationTest()
type TestApp = Awaited<ReturnType<typeof createApp>>
type Cookies = Record<string, string>

const PASSPHRASE = 'access-report-routes-passphrase'
const PASSWORD = 'correct-horse-battery-staple'
const REPORT_URL = '/api/v1/org/audit/access-report'

const { registerOwner, addUserToOrg } = createMembershipTestHelpers({
  emailPrefix: 'access-report',
  orgNamePrefix: 'Access Report',
})

function callReport(app: TestApp, cookies: Cookies, body: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: REPORT_URL,
    headers: { cookie: cookieHeader(cookies) },
    payload: body,
  })
}

async function invite(
  app: TestApp,
  cookies: Cookies,
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

/** Bare-user filler for pagination volume (AC-4): unlike `addUserToOrg` (a full self-registration
 * — including a real argon2 password hash — per call), this inserts a user + org_membership row
 * directly. AC-4 only needs 45 distinct, real org members to exercise pagination determinism; it
 * does not need each one to be a fully login-capable account. 44 real registrations here made
 * this test needlessly expensive (argon2 hashing is deliberately slow) and prone to timing out
 * under concurrent CI load with no gain in coverage. */
async function addBareMemberToOrg(orgId: string, label: string): Promise<{ userId: string }> {
  const userId = await createTestUser(label)
  await withOrg(orgId, (tx) => tx.insert(orgMemberships).values({ orgId, userId, role: 'member' }))
  return { userId }
}

/** Test-only shortcut (mirrors invitations/routes.test.ts's own `tokenForInvitation`): mints a
 * fresh plaintext token and overwrites the stored hash so the test can drive the real accept
 * endpoint without intercepting the invitation email. */
async function tokenForInvitation(orgId: string, invitationId: string): Promise<string> {
  const token = generateInvitationToken()
  await withOrg(orgId, (tx) =>
    tx
      .update(projectInvitations)
      .set({ tokenHash: hashInvitationToken(token) })
      .where(eq(projectInvitations.id, invitationId))
  )
  return token
}

async function acceptInvitationAsExistingUser(app: TestApp, cookies: Cookies, token: string) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/invitations/${token}/accept`,
    headers: { cookie: cookieHeader(cookies) },
  })
}

/**
 * Grafts a brand-new, already-registered user into `owner`'s org via a real invitation
 * accept — NOT via the test-only `addUserToOrg`/`loginExistingUserInOrg` shortcuts, which insert
 * directly into `org_memberships` and therefore leave no audit-log creation event at all. The
 * historical-replay path (D2) can only ever know about a user via `USER_REGISTERED` or
 * `project.invitation_accepted` — a membership grafted in by a test helper without going through
 * one of those two events is invisible to replay by design, which is why every replay-path test
 * below must use this helper (or the founder's own registration) rather than the shortcuts.
 */
async function inviteAndAcceptExistingUser(
  app: TestApp,
  owner: { orgId: string; cookies: Cookies },
  projectId: string,
  role: string,
  label: string
): Promise<{ userId: string; cookies: Cookies; email: string }> {
  const newUser = await registerAndLoginViaApi(app, {
    email: `access-report-${label}-${randomUUID()}@example.com`,
    password: PASSWORD,
    orgName: `Access Report ${label} Org ${randomUUID()}`,
  })
  const [row] = await getDb()
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, newUser.userId))
  const email = row?.email as string
  const created = await invite(app, owner.cookies, projectId, { email, role })
  const invitationId = created.json<{ data: { id: string } }>().data.id
  const token = await tokenForInvitation(owner.orgId, invitationId)
  const acceptRes = await acceptInvitationAsExistingUser(app, newUser.cookies, token)
  if (acceptRes.statusCode !== 200) {
    throw new Error(`expected invitation accept to succeed, got ${acceptRes.statusCode}`)
  }
  return { userId: newUser.userId, cookies: newUser.cookies, email }
}

async function eventCreatedAt(orgId: string, eventType: string, resourceId?: string) {
  const rows = await withOrg(orgId, (tx) =>
    tx
      .select({ createdAt: auditLogEntries.createdAt, resourceId: auditLogEntries.resourceId })
      .from(auditLogEntries)
      .where(eq(auditLogEntries.eventType, eventType))
  )
  const match = resourceId ? rows.find((r) => r.resourceId === resourceId) : rows[rows.length - 1]
  if (!match) throw new Error(`expected an audit row for eventType=${eventType}`)
  return match.createdAt
}

/** Sets a real pseudonymization-shaped state directly on user_identity_tokens (the pseudonymize
 * endpoint itself is Task 6 — this story's own D8 trigger already enforces the same invariants
 * the real endpoint will produce, so simulating its end-state here is a faithful proxy for AC-8's
 * "display name reflects pseudonymization" assertion, decoupled from Task 6's own test suite). */
async function pseudonymizeDirectly(userId: string, alias: string): Promise<void> {
  await getDb()
    .update(userIdentityTokens)
    .set({ displayName: alias, pseudonymizedAt: new Date() })
    .where(eq(userIdentityTokens.userId, userId))
}

describe('POST /api/v1/org/audit/access-report — fast path, validation, auth (AC-1, AC-4, AC-5, AC-6, AC-7, AC-8)', () => {
  let app: TestApp

  beforeAll(async () => {
    await resetVaultForTest()
    await initVaultForTest(initVault, PASSPHRASE)
    app = await createApp({ logger: false, vaultGuardEnabled: true })
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  it('AC-1: returns current-state access for owner/admin/member with per-project roles', async () => {
    const owner = await registerOwner(app, 'happy')
    const admin = await addUserToOrg(app, owner.orgId, 'happy-admin', { orgRole: 'admin' })
    const member = await addUserToOrg(app, owner.orgId, 'happy-member', { orgRole: 'member' })
    const projectA = await createProjectViaApi(app, owner.cookies, 'happy-a')
    const projectB = await createProjectViaApi(app, owner.cookies, 'happy-b')
    await withOrg(owner.orgId, async (tx) => {
      const { projectMemberships } = await import('@project-vault/db/schema')
      await tx.insert(projectMemberships).values([
        { orgId: owner.orgId, projectId: projectA, userId: member.userId, role: 'member' },
        { orgId: owner.orgId, projectId: projectB, userId: member.userId, role: 'admin' },
      ])
    })

    const res = await callReport(app, owner.cookies, {})

    expect(res.statusCode).toBe(200)
    const body = res.json<{
      data: {
        users: { userId: string; orgRole: string; status: string; projects: unknown[] }[]
        page: number
        limit: number
        total: number
        hasNext: boolean
        asOf: string
        generatedAt: string
      }
    }>().data
    expect(body.total).toBe(3)
    const byId = new Map(body.users.map((u) => [u.userId, u]))
    expect(byId.get(owner.userId)?.orgRole).toBe('owner')
    expect(byId.get(admin.userId)?.orgRole).toBe('admin')
    expect(byId.get(admin.userId)?.projects).toEqual([])
    expect(byId.get(member.userId)?.projects).toHaveLength(2)
    // Sorted userId ASC (D2 deterministic ordering).
    const ids = body.users.map((u) => u.userId)
    expect([...ids].sort()).toEqual(ids)
  })

  it('AC-1 edge case: an org with only the founding owner returns exactly one user, not an error', async () => {
    const owner = await registerOwner(app, 'solo')

    const res = await callReport(app, owner.cookies, {})

    expect(res.statusCode).toBe(200)
    const body = res.json<{ data: { users: unknown[]; total: number } }>().data
    expect(body.total).toBe(1)
    expect(body.users).toHaveLength(1)
  })

  it('AC-1 edge case: an explicit asOf equal to "now" still takes the historical path, not the fast path', async () => {
    const owner = await registerOwner(app, 'now-boundary')

    const res = await callReport(app, owner.cookies, { asOf: new Date().toISOString() })

    // Still 200 with the founder visible via the historical replay's USER_REGISTERED handling —
    // confirms this isn't silently routed to the fast path just because asOf ~= now.
    expect(res.statusCode).toBe(200)
    const body = res.json<{ data: { users: { userId: string }[] } }>().data
    expect(body.users.map((u) => u.userId)).toContain(owner.userId)
  })

  it('AC-4: paginates a 45-user org deterministically across page 2/3', async () => {
    const owner = await registerOwner(app, 'paging')
    const memberIds: string[] = [owner.userId]
    for (let i = 0; i < 44; i += 1) {
      const m = await addBareMemberToOrg(owner.orgId, `paging-${i}`)
      memberIds.push(m.userId)
    }

    const page2 = await callReport(app, owner.cookies, { page: 2, limit: 20 })
    expect(page2.statusCode).toBe(200)
    const page2Body = page2.json<{
      data: { users: { userId: string }[]; total: number; hasNext: boolean }
    }>().data
    expect(page2Body.users).toHaveLength(20)
    expect(page2Body.total).toBe(45)
    expect(page2Body.hasNext).toBe(true)

    const page3 = await callReport(app, owner.cookies, { page: 3, limit: 20 })
    const page3Body = page3.json<{ data: { users: { userId: string }[]; hasNext: boolean } }>().data
    expect(page3Body.users).toHaveLength(5)
    expect(page3Body.hasNext).toBe(false)

    // Byte-identical repeat pagination (comparing the users array only — generatedAt/asOf
    // legitimately differ between the two fast-path calls' "now" timestamps).
    const page2Again = await callReport(app, owner.cookies, { page: 2, limit: 20 })
    const page2AgainBody = page2Again.json<{ data: { users: unknown[] } }>().data
    expect(page2AgainBody.users).toEqual(page2Body.users)
  }, 30_000)

  it('AC-4 edge case: page beyond available data returns 200 with an empty array, not 404', async () => {
    const owner = await registerOwner(app, 'paging-beyond')

    const res = await callReport(app, owner.cookies, { page: 100, limit: 20 })

    expect(res.statusCode).toBe(200)
    const body = res.json<{ data: { users: unknown[]; total: number; hasNext: boolean } }>().data
    expect(body.users).toEqual([])
    expect(body.hasNext).toBe(false)
  })

  it('AC-5: rejects a malformed asOf (schema-level validation)', async () => {
    const owner = await registerOwner(app, 'invalid-date')

    const res = await callReport(app, owner.cookies, { asOf: 'not-a-date' })

    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({ code: 'validation_error' })
  })

  it('AC-5: rejects a bare date without time', async () => {
    const owner = await registerOwner(app, 'bare-date')

    const res = await callReport(app, owner.cookies, { asOf: '2026-01-01' })

    expect(res.statusCode).toBe(422)
  })

  it('AC-5 edge case: rejects an asOf in the future', async () => {
    const owner = await registerOwner(app, 'future-date')
    const future = new Date(Date.now() + 60_000).toISOString()

    const res = await callReport(app, owner.cookies, { asOf: future })

    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({ code: 'invalid_as_of' })
  })

  it('AC-5 edge case: rejects an asOf predating the organization', async () => {
    const owner = await registerOwner(app, 'predates-org')
    const before = new Date(Date.now() - 365 * 86_400_000).toISOString()

    const res = await callReport(app, owner.cookies, { asOf: before })

    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({ code: 'invalid_as_of' })
  })

  it('AC-6: rejects admin/member/viewer callers with 403', async () => {
    const owner = await registerOwner(app, 'forbidden')
    const admin = await addUserToOrg(app, owner.orgId, 'forbidden-admin', { orgRole: 'admin' })
    const member = await addUserToOrg(app, owner.orgId, 'forbidden-member', { orgRole: 'member' })
    const viewer = await addUserToOrg(app, owner.orgId, 'forbidden-viewer', { orgRole: 'viewer' })

    for (const caller of [admin, member, viewer]) {
      const res = await callReport(app, caller.cookies, {})
      expect(res.statusCode).toBe(403)
    }
  })

  it('AC-6 edge case: cross-org isolation — Org A sees only Org A users', async () => {
    await withTwoTestOrgs(async ({ orgAId, orgBId }) => {
      const ownerAEmail = `access-report-cross-a-${randomUUID()}@example.com`
      const ownerBEmail = `access-report-cross-b-${randomUUID()}@example.com`
      const [ownerA] = await getDb()
        .insert(users)
        .values({ email: ownerAEmail, passwordHash: 'x' })
        .returning({ id: users.id })
      const [ownerB] = await getDb()
        .insert(users)
        .values({ email: ownerBEmail, passwordHash: 'x' })
        .returning({ id: users.id })
      if (!ownerA || !ownerB) throw new Error('expected test users to be inserted')
      const { orgMemberships } = await import('@project-vault/db/schema')
      await withOrg(orgAId, (tx) =>
        tx.insert(orgMemberships).values({ orgId: orgAId, userId: ownerA.id, role: 'owner' })
      )
      await withOrg(orgBId, (tx) =>
        tx.insert(orgMemberships).values({ orgId: orgBId, userId: ownerB.id, role: 'owner' })
      )
      const [tokenA] = await getDb()
        .insert(userIdentityTokens)
        .values({ userId: ownerA.id, displayName: ownerAEmail })
        .returning({ id: userIdentityTokens.id })
      const [tokenB] = await getDb()
        .insert(userIdentityTokens)
        .values({ userId: ownerB.id, displayName: ownerBEmail })
        .returning({ id: userIdentityTokens.id })
      if (!tokenA || !tokenB) throw new Error('expected identity tokens to be inserted')

      const { mintOrgSessionCookies } = await import('../../__tests__/helpers/auth-test-helpers.js')
      const cookiesA = await mintOrgSessionCookies(app, ownerA.id, orgAId)

      const res = await callReport(app, cookiesA, {})
      expect(res.statusCode).toBe(200)
      const body = res.json<{ data: { users: { userId: string }[] } }>().data
      expect(body.users.map((u) => u.userId)).toEqual([ownerA.id])
    })
  })

  it('AC-7: writes an audit.access_report_generated row on success', async () => {
    const owner = await registerOwner(app, 'audited')

    const res = await callReport(app, owner.cookies, {})
    expect(res.statusCode).toBe(200)

    const rows = await withOrg(owner.orgId, (tx) =>
      tx
        .select()
        .from(auditLogEntries)
        .where(eq(auditLogEntries.eventType, 'audit.access_report_generated'))
    )
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0]?.payload).toMatchObject({ format: 'json' })
  })

  it('AC-8: displayName reflects pseudonymization, never raw email — and diverges from GET /org/users', async () => {
    const owner = await registerOwner(app, 'pseudonymized')
    const member = await addUserToOrg(app, owner.orgId, 'pseudonymized-member', {
      orgRole: 'member',
    })
    await pseudonymizeDirectly(member.userId, 'user_ab12cd34')

    const reportRes = await callReport(app, owner.cookies, {})
    const reportBody = reportRes.json<{
      data: { users: { userId: string; displayName: string }[] }
    }>().data
    const reportedMember = reportBody.users.find((u) => u.userId === member.userId)
    expect(reportedMember?.displayName).toBe('user_ab12cd34')

    // AC-8 regression guard: the existing 4.2 endpoint still derives displayName from email
    // (D3's own documented convention) — the two endpoints must diverge, not converge.
    const usersListRes = await app.inject({
      method: 'GET',
      url: '/api/v1/org/users',
      headers: { cookie: cookieHeader(owner.cookies) },
    })
    const usersListBody = usersListRes.json<{ data: { userId: string; displayName: string }[] }>()
      .data
    const listedMember = usersListBody.find((u) => u.userId === member.userId)
    expect(listedMember?.displayName).toBe(member.email)
    expect(listedMember?.displayName).not.toBe(reportedMember?.displayName)
  })
})

describe('POST /api/v1/org/audit/access-report — historical replay (AC-2)', () => {
  let app: TestApp

  beforeAll(async () => {
    await resetVaultForTest()
    await initVaultForTest(initVault, PASSPHRASE)
    app = await createApp({ logger: false, vaultGuardEnabled: true })
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  it('reconstructs grant -> promotion -> removal history via replay, including the founding owner', async () => {
    const owner = await registerOwner(app, 'replay')
    const t0 = await eventCreatedAt(owner.orgId, 'USER_REGISTERED')

    const projectId = await createProjectViaApi(app, owner.cookies, 'replay-project')
    const userA = await registerAndLoginViaApi(app, {
      email: `access-report-replay-usera-${randomUUID()}@example.com`,
      password: PASSWORD,
      orgName: `Replay UserA Org ${randomUUID()}`,
    })

    const [userARow] = await getDb()
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userA.userId))
    const email = userARow?.email as string
    const created = await invite(app, owner.cookies, projectId, { email, role: 'member' })
    const invitationId = created.json<{ data: { id: string } }>().data.id
    const token = await tokenForInvitation(owner.orgId, invitationId)
    const acceptRes = await acceptInvitationAsExistingUser(app, userA.cookies, token)
    expect(acceptRes.statusCode).toBe(200)
    const t1 = await eventCreatedAt(owner.orgId, 'project.invitation_accepted', invitationId)

    const roleChangeRes = await app.inject({
      method: 'PUT',
      url: `/api/v1/org/users/${userA.userId}/projects/${projectId}/role`,
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { role: 'admin' },
    })
    expect(roleChangeRes.statusCode).toBe(200)
    const t2 = await eventCreatedAt(owner.orgId, 'project.member_role_changed', userA.userId)

    const removeRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/org/users/${userA.userId}`,
      headers: { cookie: cookieHeader(owner.cookies) },
    })
    expect(removeRes.statusCode).toBe(200)
    const t3 = await eventCreatedAt(owner.orgId, 'org.user_removed', userA.userId)

    // Founding-owner-visible: an asOf immediately after registration shows exactly the founder.
    const founderRes = await callReport(app, owner.cookies, {
      asOf: new Date(t0.getTime() + 1).toISOString(),
    })
    expect(founderRes.statusCode).toBe(200)
    const founderBody = founderRes.json<{
      data: { users: { userId: string; orgRole: string }[] }
    }>().data
    expect(founderBody.users.map((u) => u.userId)).toEqual([owner.userId])
    expect(founderBody.users[0]?.orgRole).toBe('owner')

    // Between grant (t1) and promotion (t2): userA appears with role 'member'.
    const prePromotionAsOf = new Date(t1.getTime() + 1)
    if (prePromotionAsOf.getTime() < t2.getTime()) {
      const preRes = await callReport(app, owner.cookies, { asOf: prePromotionAsOf.toISOString() })
      const preBody = preRes.json<{
        data: { users: { userId: string; projects: { projectId: string; role: string }[] }[] }
      }>().data
      const userAEntry = preBody.users.find((u) => u.userId === userA.userId)
      expect(userAEntry?.projects.find((p) => p.projectId === projectId)?.role).toBe('member')
    }

    // Between promotion (t2) and removal (t3): userA appears with role 'admin'.
    const postPromotionAsOf = new Date(t2.getTime() + 1)
    if (postPromotionAsOf.getTime() < t3.getTime()) {
      const postRes = await callReport(app, owner.cookies, {
        asOf: postPromotionAsOf.toISOString(),
      })
      const postBody = postRes.json<{
        data: { users: { userId: string; projects: { projectId: string; role: string }[] }[] }
      }>().data
      const userAEntry = postBody.users.find((u) => u.userId === userA.userId)
      expect(userAEntry?.projects.find((p) => p.projectId === projectId)?.role).toBe('admin')
    }

    // After removal (t3): userA no longer appears at all.
    const afterRemovalRes = await callReport(app, owner.cookies, {
      asOf: new Date(t3.getTime() + 1).toISOString(),
    })
    const afterRemovalBody = afterRemovalRes.json<{ data: { users: { userId: string }[] } }>().data
    expect(afterRemovalBody.users.map((u) => u.userId)).not.toContain(userA.userId)
  }, 30_000)

  it('AC-2 critical: a historical asOf generated right after pseudonymizing a still-active user shows the alias, never the real historical name (D4)', async () => {
    const owner = await registerOwner(app, 'pseudo-historical')
    const projectId = await createProjectViaApi(app, owner.cookies, 'pseudo-historical-project')
    const userB = await inviteAndAcceptExistingUser(
      app,
      owner,
      projectId,
      'member',
      'pseudo-historical-b'
    )
    const t1 = new Date()
    await new Promise((resolve) => setTimeout(resolve, 5))

    await pseudonymizeDirectly(userB.userId, 'user_zz99xx88')

    // A historical asOf BEFORE the pseudonymize call (t1, when the user's real email was truly
    // in effect) — D4 says displayName resolution is always current-state, so the alias must
    // still show, confirming this is deliberate, not a bug.
    const res = await callReport(app, owner.cookies, { asOf: t1.toISOString() })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ data: { users: { userId: string; displayName: string }[] } }>().data
    const userBEntry = body.users.find((u) => u.userId === userB.userId)
    expect(userBEntry?.displayName).toBe('user_zz99xx88')
  })

  it('project.ownership_transferred derives both the demotion and promotion transitions from one event', async () => {
    const owner = await registerOwner(app, 'transfer')
    const projectId = await createProjectViaApi(app, owner.cookies, 'transfer-project')
    // AC-E4c: the new owner must already be an accepted project member before transfer — achieved
    // here via a real invitation accept, which also gives them a genuine, replay-visible
    // project.invitation_accepted creation event (unlike the addUserToOrg test shortcut).
    const newOwner = await inviteAndAcceptExistingUser(
      app,
      owner,
      projectId,
      'member',
      'transfer-new-owner'
    )

    const transferRes = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/transfer-ownership`,
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { newOwnerId: newOwner.userId },
    })
    expect(transferRes.statusCode).toBe(200)
    const transferredAt = await eventCreatedAt(
      owner.orgId,
      'project.ownership_transferred',
      projectId
    )

    const res = await callReport(app, owner.cookies, {
      asOf: new Date(transferredAt.getTime() + 1).toISOString(),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<{
      data: { users: { userId: string; projects: { projectId: string; role: string }[] }[] }
    }>().data
    const previousOwnerEntry = body.users.find((u) => u.userId === owner.userId)
    const newOwnerEntry = body.users.find((u) => u.userId === newOwner.userId)
    expect(previousOwnerEntry?.projects.find((p) => p.projectId === projectId)?.role).toBe('admin')
    expect(newOwnerEntry?.projects.find((p) => p.projectId === projectId)?.role).toBe('owner')
  }, 30_000)

  it('org.user_deactivated: user remains in the report with status "deactivated" (not removed)', async () => {
    const owner = await registerOwner(app, 'deactivate-replay')
    const projectId = await createProjectViaApi(app, owner.cookies, 'deactivate-replay-project')
    const member = await inviteAndAcceptExistingUser(
      app,
      owner,
      projectId,
      'member',
      'deactivate-replay-member'
    )

    const deactivateRes = await app.inject({
      method: 'POST',
      url: `/api/v1/org/users/${member.userId}/deactivate`,
      headers: { cookie: cookieHeader(owner.cookies) },
    })
    expect(deactivateRes.statusCode).toBe(200)
    const deactivatedAt = await eventCreatedAt(owner.orgId, 'org.user_deactivated', member.userId)

    const res = await callReport(app, owner.cookies, {
      asOf: new Date(deactivatedAt.getTime() + 1).toISOString(),
    })
    const body = res.json<{ data: { users: { userId: string; status: string }[] } }>().data
    const memberEntry = body.users.find((u) => u.userId === member.userId)
    expect(memberEntry).toBeDefined()
    expect(memberEntry?.status).toBe('deactivated')
  })
})

describe('POST /api/v1/org/audit/access-report — CSV export (AC-3)', () => {
  let app: TestApp

  beforeAll(async () => {
    await resetVaultForTest()
    await initVaultForTest(initVault, PASSPHRASE)
    app = await createApp({ logger: false, vaultGuardEnabled: true })
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  it('returns text/csv with the header row and one row per user (zero-project users included)', async () => {
    const owner = await registerOwner(app, 'csv')

    const res = await callReport(app, owner.cookies, { format: 'csv' })

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/csv')
    const csv = (res as unknown as { payload: string }).payload
    const lines = csv.trim().split('\n')
    expect(lines[0]).toBe('user_id,display_name,org_role,status,project_id,project_role,granted_at')
    expect(lines.length).toBeGreaterThanOrEqual(2)
    expect(lines[1]).toContain(owner.userId)
  })

  it('defensive-coding test: RFC4180-quotes a display name containing a comma and embedded quotes', async () => {
    const owner = await registerOwner(app, 'csv-quoting')
    const member = await addUserToOrg(app, owner.orgId, 'csv-quoting-member', { orgRole: 'member' })
    await getDb()
      .update(userIdentityTokens)
      .set({ displayName: 'Chen, Alice "AC"' })
      .where(eq(userIdentityTokens.userId, member.userId))

    const res = await callReport(app, owner.cookies, { format: 'csv' })

    expect(res.statusCode).toBe(200)
    const csv = (res as unknown as { payload: string }).payload
    expect(csv).toContain('"Chen, Alice ""AC"""')
  })
})
