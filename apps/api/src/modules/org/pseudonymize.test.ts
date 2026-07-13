import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { asc, eq } from 'drizzle-orm'
import { getDb, withOrg } from '@project-vault/db'
import { auditLogEntries, orgMemberships, userIdentityTokens } from '@project-vault/db/schema'
import { createTestUser } from '@project-vault/db/test-helpers'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  initVaultForTest,
  mintOrgSessionCookies,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { createMembershipTestHelpers } from '../../__tests__/helpers/membership-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import { verifyAuditRange } from '../audit/verify.js'
import { pseudonymizeUser } from './pseudonymize.js'

/**
 * Unlike `addUserToOrg` (which self-registers the user into their OWN brand-new org first, then
 * grafts them into the target org — meaning that user always belongs to at least 2 orgs), this
 * creates a user with EXACTLY one org membership, for tests that assert a precise
 * `otherAffectedOrgCount` (D9/AC-17a).
 */
async function addBareMemberToOrg(
  orgId: string,
  label: string,
  role: string
): Promise<{ userId: string }> {
  const userId = await createTestUser(label)
  await withOrg(orgId, (tx) => tx.insert(orgMemberships).values({ orgId, userId, role }))
  return { userId }
}

const { createApp, initVault } = await bootstrapRouteIntegrationTest()
type TestApp = Awaited<ReturnType<typeof createApp>>

const PASSPHRASE = 'pseudonymize-routes-passphrase'
const USER_PSEUDONYMIZED_EVENT = 'user.pseudonymized'
const { registerOwner, addUserToOrg } = createMembershipTestHelpers({
  emailPrefix: 'pseudonymize',
  orgNamePrefix: 'Pseudonymize',
})

function pseudonymizeUrl(userId: string): string {
  return `/api/v1/org/users/${userId}/pseudonymize`
}

async function callPseudonymize(
  app: TestApp,
  cookies: Record<string, string>,
  userId: string,
  body: Record<string, unknown>
) {
  return app.inject({
    method: 'POST',
    url: pseudonymizeUrl(userId),
    headers: { cookie: cookieHeader(cookies) },
    payload: body,
  })
}

describe('POST /api/v1/org/users/:userId/pseudonymize', () => {
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

  it('AC-17: pseudonymizes the target, returning the alias and pseudonymizedAt', async () => {
    const owner = await registerOwner(app, 'happy')
    const member = await addBareMemberToOrg(owner.orgId, 'happy-member', 'member')

    const res = await callPseudonymize(app, owner.cookies, member.userId, {
      confirmUserId: member.userId,
    })

    expect(res.statusCode).toBe(200)
    const body = res.json<{
      data: {
        userId: string
        pseudonymized: boolean
        pseudonymizedAt: string
        alias: string
        otherAffectedOrgCount: number
      }
    }>().data
    expect(body.userId).toBe(member.userId)
    expect(body.pseudonymized).toBe(true)
    expect(body.alias).toMatch(/^user_[a-z0-9]{8}$/)
    expect(body.otherAffectedOrgCount).toBe(0)

    const [row] = await getDb()
      .select()
      .from(userIdentityTokens)
      .where(eq(userIdentityTokens.userId, member.userId))
    expect(row?.displayName).toBe(body.alias)
    expect(row?.pseudonymizedAt).not.toBeNull()
  })

  it('AC-17 edge case: a user with two user_identity_tokens rows gets both updated to the same alias', async () => {
    const owner = await registerOwner(app, 'multi-token')
    const member = await addUserToOrg(app, owner.orgId, 'multi-token-member', {
      orgRole: 'member',
    })
    await getDb()
      .insert(userIdentityTokens)
      .values({ userId: member.userId, displayName: 'second-row@example.com' })

    const res = await callPseudonymize(app, owner.cookies, member.userId, {
      confirmUserId: member.userId,
    })
    expect(res.statusCode).toBe(200)
    const alias = res.json<{ data: { alias: string } }>().data.alias

    const rows = await getDb()
      .select()
      .from(userIdentityTokens)
      .where(eq(userIdentityTokens.userId, member.userId))
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.displayName === alias)).toBe(true)
    expect(rows.every((r) => r.pseudonymizedAt !== null)).toBe(true)
  })

  it('AC-17a: rejects a request with a missing confirmUserId (422, no mutation)', async () => {
    const owner = await registerOwner(app, 'no-confirm')
    const member = await addUserToOrg(app, owner.orgId, 'no-confirm-member', {
      orgRole: 'member',
    })

    const res = await callPseudonymize(app, owner.cookies, member.userId, {})

    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({ code: 'confirmation_required' })

    const [row] = await getDb()
      .select()
      .from(userIdentityTokens)
      .where(eq(userIdentityTokens.userId, member.userId))
    expect(row?.pseudonymizedAt).toBeNull()
  })

  it('AC-17a: rejects a confirmUserId that does not match the target', async () => {
    const owner = await registerOwner(app, 'mismatch-confirm')
    const member = await addUserToOrg(app, owner.orgId, 'mismatch-confirm-member', {
      orgRole: 'member',
    })

    const res = await callPseudonymize(app, owner.cookies, member.userId, {
      confirmUserId: randomUUID(),
    })

    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({ code: 'confirmation_required' })
  })

  it('AC-17a edge case: surfaces otherAffectedOrgCount: 2 for a user in 2 other orgs', async () => {
    const owner = await registerOwner(app, 'blast-radius')
    const member = await addBareMemberToOrg(owner.orgId, 'blast-radius-member', 'member')
    const otherOrg1 = await registerOwner(app, 'blast-radius-other-1')
    const otherOrg2 = await registerOwner(app, 'blast-radius-other-2')
    await withOrg(otherOrg1.orgId, (tx) =>
      tx
        .insert(orgMemberships)
        .values({ orgId: otherOrg1.orgId, userId: member.userId, role: 'member' })
    )
    await withOrg(otherOrg2.orgId, (tx) =>
      tx
        .insert(orgMemberships)
        .values({ orgId: otherOrg2.orgId, userId: member.userId, role: 'member' })
    )

    const res = await callPseudonymize(app, owner.cookies, member.userId, {
      confirmUserId: member.userId,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json<{ data: { otherAffectedOrgCount: number } }>().data.otherAffectedOrgCount).toBe(
      2
    )
  })

  it('AC-17a edge case: otherAffectedOrgCount is 0 for a single-org user, confirmation still required', async () => {
    const owner = await registerOwner(app, 'single-org')
    const member = await addBareMemberToOrg(owner.orgId, 'single-org-member', 'member')

    const res = await callPseudonymize(app, owner.cookies, member.userId, {
      confirmUserId: member.userId,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json<{ data: { otherAffectedOrgCount: number } }>().data.otherAffectedOrgCount).toBe(
      0
    )
  })

  it('AC-18: re-pseudonymizing an already-pseudonymized user is a no-op returning the same alias/timestamp', async () => {
    const owner = await registerOwner(app, 'idempotent')
    const member = await addUserToOrg(app, owner.orgId, 'idempotent-member', {
      orgRole: 'member',
    })

    const first = await callPseudonymize(app, owner.cookies, member.userId, {
      confirmUserId: member.userId,
    })
    const firstBody = first.json<{ data: { alias: string; pseudonymizedAt: string } }>().data

    const second = await callPseudonymize(app, owner.cookies, member.userId, {
      confirmUserId: member.userId,
    })
    expect(second.statusCode).toBe(200)
    const secondBody = second.json<{ data: { alias: string; pseudonymizedAt: string } }>().data
    expect(secondBody.alias).toBe(firstBody.alias)
    expect(secondBody.pseudonymizedAt).toBe(firstBody.pseudonymizedAt)
  })

  it('AC-18 edge case: the DB trigger itself blocks a direct UPDATE that tries to change display_name post-pseudonymization', async () => {
    const owner = await registerOwner(app, 'trigger-guard')
    const member = await addUserToOrg(app, owner.orgId, 'trigger-guard-member', {
      orgRole: 'member',
    })
    await callPseudonymize(app, owner.cookies, member.userId, { confirmUserId: member.userId })

    let caught: unknown
    try {
      await getDb()
        .update(userIdentityTokens)
        .set({ displayName: 'something-else' })
        .where(eq(userIdentityTokens.userId, member.userId))
    } catch (error) {
      caught = error
    }
    expect(caught).toBeDefined()
    const cause = caught instanceof Error ? caught.cause : undefined
    const causeMessage = cause instanceof Error ? cause.message : String(cause)
    expect(causeMessage).toMatch(/GDPR erasure is permanent/)
  })

  it('AC-19: HMAC integrity of existing audit rows is unaffected by pseudonymization', async () => {
    const owner = await registerOwner(app, 'hmac-preserved')
    const member = await addUserToOrg(app, owner.orgId, 'hmac-preserved-member', {
      orgRole: 'member',
    })
    const from = new Date(Date.now() - 60_000).toISOString()

    const before = await withOrg(owner.orgId, (tx) =>
      verifyAuditRange(tx, { orgId: owner.orgId, from, to: new Date().toISOString() })
    )
    expect(before.failedCount).toBe(0)

    await callPseudonymize(app, owner.cookies, member.userId, { confirmUserId: member.userId })

    const after = await withOrg(owner.orgId, (tx) =>
      verifyAuditRange(tx, { orgId: owner.orgId, from, to: new Date().toISOString() })
    )
    expect(after.failedCount).toBe(0)
    expect(after.passed).toBeGreaterThanOrEqual(before.passed)
  })

  it('AC-19 edge case: a new audit row written after pseudonymization uses the same actor_token_id', async () => {
    const owner = await registerOwner(app, 'post-pseudo-audit')
    const member = await addUserToOrg(app, owner.orgId, 'post-pseudo-audit-member', {
      orgRole: 'member',
    })
    await callPseudonymize(app, owner.cookies, member.userId, { confirmUserId: member.userId })

    const memberCookies = await mintOrgSessionCookies(app, member.userId, owner.orgId)
    // Any authenticated action that writes an audit row as this user — recovery-link send by an
    // admin targets the user, but a project creation authored by the pseudonymized user is a
    // simpler, always-available action to exercise their own actor_token_id post-pseudonymization.
    await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie: cookieHeader(memberCookies) },
      payload: { name: 'Post-pseudo project', slug: `post-pseudo-${randomUUID().slice(0, 8)}` },
    })

    const [tokenRow] = await getDb()
      .select({ id: userIdentityTokens.id })
      .from(userIdentityTokens)
      .where(eq(userIdentityTokens.userId, member.userId))
    const rows = await withOrg(owner.orgId, (tx) =>
      tx
        .select({
          actorTokenId: auditLogEntries.actorTokenId,
          eventType: auditLogEntries.eventType,
        })
        .from(auditLogEntries)
        .where(eq(auditLogEntries.eventType, 'project.created'))
    )
    expect(rows.some((r) => r.actorTokenId === tokenRow?.id)).toBe(true)
  })

  it('AC-20: rejects admin/member/viewer callers with 403', async () => {
    const owner = await registerOwner(app, 'forbidden')
    const admin = await addUserToOrg(app, owner.orgId, 'forbidden-admin', { orgRole: 'admin' })
    const member = await addUserToOrg(app, owner.orgId, 'forbidden-member', { orgRole: 'member' })
    const viewer = await addUserToOrg(app, owner.orgId, 'forbidden-viewer', { orgRole: 'viewer' })
    const target = await addUserToOrg(app, owner.orgId, 'forbidden-target', { orgRole: 'member' })

    for (const caller of [admin, member, viewer]) {
      const res = await callPseudonymize(app, caller.cookies, target.userId, {
        confirmUserId: target.userId,
      })
      expect(res.statusCode).toBe(403)
    }
  }, // Story 10.4: 4 real user registrations + 3 sequential requests; previously relied on the
  // global testTimeout default (raised 45s->60s) but has still been observed timing out at
  // exactly that boundary under this session's shared-machine contention.
  90_000)

  it('AC-20 edge case: 404 (not 403) for a target who only belongs to a different org', async () => {
    const owner = await registerOwner(app, 'cross-org-target')
    const otherOrgOwner = await registerOwner(app, 'cross-org-target-other')

    const res = await callPseudonymize(app, owner.cookies, otherOrgOwner.userId, {
      confirmUserId: otherOrgOwner.userId,
    })

    expect(res.statusCode).toBe(404)
  })

  it('AC-21: writes a user.pseudonymized audit row excluding PII, including the blast-radius fields', async () => {
    const owner = await registerOwner(app, 'audited')
    const member = await addBareMemberToOrg(owner.orgId, 'audited-member', 'member')

    const res = await callPseudonymize(app, owner.cookies, member.userId, {
      confirmUserId: member.userId,
    })
    expect(res.statusCode).toBe(200)

    const rows = await withOrg(owner.orgId, (tx) =>
      tx
        .select()
        .from(auditLogEntries)
        .where(eq(auditLogEntries.eventType, USER_PSEUDONYMIZED_EVENT))
    )
    expect(rows).toHaveLength(1)
    const payload = rows[0]?.payload as Record<string, unknown>
    expect(payload).toMatchObject({
      targetUserId: member.userId,
      tokensPseudonymized: 1,
      otherAffectedOrgCount: 0,
      otherAffectedOrgIds: [],
    })
    expect(JSON.stringify(payload)).not.toContain('@example.com')
    expect(JSON.stringify(payload)).not.toContain('user_')
  })

  it('AC-21 edge case: a no-op re-pseudonymize call is still audited, with tokensPseudonymized: 0', async () => {
    const owner = await registerOwner(app, 'audited-noop')
    const member = await addUserToOrg(app, owner.orgId, 'audited-noop-member', {
      orgRole: 'member',
    })

    await callPseudonymize(app, owner.cookies, member.userId, { confirmUserId: member.userId })
    await callPseudonymize(app, owner.cookies, member.userId, { confirmUserId: member.userId })

    const rows = await withOrg(owner.orgId, (tx) =>
      tx
        .select()
        .from(auditLogEntries)
        .where(eq(auditLogEntries.eventType, USER_PSEUDONYMIZED_EVENT))
        .orderBy(asc(auditLogEntries.createdAt))
    )
    expect(rows).toHaveLength(2)
    expect((rows[0]?.payload as Record<string, unknown>)['tokensPseudonymized']).toBe(1)
    expect((rows[1]?.payload as Record<string, unknown>)['tokensPseudonymized']).toBe(0)
  })

  it('AC-22: pseudonymizing from Org A also changes the display name Org B sees for the same user', async () => {
    const orgAOwner = await registerOwner(app, 'bleed-a')
    const orgBOwner = await registerOwner(app, 'bleed-b')
    const sharedUser = await addUserToOrg(app, orgAOwner.orgId, 'bleed-shared', {
      orgRole: 'member',
    })
    const { orgMemberships } = await import('@project-vault/db/schema')
    await withOrg(orgBOwner.orgId, (tx) =>
      tx
        .insert(orgMemberships)
        .values({ orgId: orgBOwner.orgId, userId: sharedUser.userId, role: 'member' })
    )

    // AC-22/D9: this cross-org bleed is the accepted, documented trade-off — Org A's action
    // changes what Org B's own reports/exports show for this shared user, with no notification
    // to Org B (the edge case below asserts that absence explicitly, not as an oversight).
    await callPseudonymize(app, orgAOwner.cookies, sharedUser.userId, {
      confirmUserId: sharedUser.userId,
    })

    const [row] = await getDb()
      .select()
      .from(userIdentityTokens)
      .where(eq(userIdentityTokens.userId, sharedUser.userId))
    expect(row?.displayName).toMatch(/^user_[a-z0-9]{8}$/)

    // Edge case: Org B has no breadcrumb of this — its own audit log has no user.pseudonymized row.
    const orgBRows = await withOrg(orgBOwner.orgId, (tx) =>
      tx
        .select()
        .from(auditLogEntries)
        .where(eq(auditLogEntries.eventType, USER_PSEUDONYMIZED_EVENT))
    )
    expect(orgBRows).toHaveLength(0)
  })

  it('Task 6.7: pseudonymizeUser is callable internally, with only a tx and plain IDs (no SecureRouteContext)', async () => {
    const owner = await registerOwner(app, 'internal-call')
    const member = await addBareMemberToOrg(owner.orgId, 'internal-call-member', 'member')

    const result = await withOrg(owner.orgId, (tx) =>
      pseudonymizeUser(tx, { targetUserId: member.userId, callerOrgId: owner.orgId })
    )

    expect(result.alias).toMatch(/^user_[a-z0-9]{8}$/)
    expect(result.tokensPseudonymized).toBe(1)
    expect(result.otherAffectedOrgCount).toBe(0)
    expect(result.otherAffectedOrgIds).toEqual([])
    expect(result.pseudonymizedAt).toBeInstanceOf(Date)
  })
})
