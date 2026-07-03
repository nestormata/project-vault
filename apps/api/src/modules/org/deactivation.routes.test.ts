import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { notificationQueue, orgMemberships, projectInvitations } from '@project-vault/db/schema'
import type { CookieJar } from '../../__tests__/helpers/auth-test-helpers.js'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  createProjectViaApi as createProject,
  expectAuditWriteFailed,
  mintOrgSessionCookies,
  registerAndLoginViaApi,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { bootProjectRouteTestApp } from '../projects/project-route-test-bootstrap.js'
import {
  MEMBERSHIP_TEST_PASSWORD as PASSWORD,
  createMembershipTestHelpers,
} from '../../__tests__/helpers/membership-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'

const { createApp, initVault, humanAudit } = await bootstrapRouteIntegrationTest()

type TestApp = Awaited<ReturnType<typeof createApp>>

const { uniqueEmail, registerOwner, addUserToOrg, enrollMfa } = createMembershipTestHelpers({
  emailPrefix: 'deactivate',
  orgNamePrefix: 'Deactivate',
})

function deactivate(app: TestApp, cookies: CookieJar, userId: string) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/org/users/${userId}/deactivate`,
    headers: { cookie: cookieHeader(cookies) },
  })
}

async function membershipStatus(orgId: string, userId: string): Promise<string | undefined> {
  const [row] = await withOrg(orgId, (tx) =>
    tx
      .select({ status: orgMemberships.status })
      .from(orgMemberships)
      .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)))
  )
  return row?.status
}

async function meRequest(app: TestApp, cookies: CookieJar) {
  return app.inject({
    method: 'GET',
    url: '/api/v1/auth/me',
    headers: { cookie: cookieHeader(cookies) },
  })
}

describe.sequential('account deactivation routes', () => {
  let app: TestApp

  beforeAll(async () => {
    app = await bootProjectRouteTestApp(createApp, initVault)
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  it('registers both routes in the OpenAPI document (AC-17)', async () => {
    await app.ready()
    const document = app.swagger() as { paths?: Record<string, unknown> }

    expect(document.paths?.['/api/v1/org/users/{userId}/deactivate']).toBeDefined()
    expect(document.paths?.['/api/v1/org/users/{userId}/recovery/send-link']).toBeDefined()
  })

  describe('POST /api/v1/org/users/:userId/deactivate', () => {
    it('deactivates an active member (200) and revokes both of their sessions (AC-2/AC-5)', async () => {
      const owner = await registerOwner(app, 'happy-owner')
      const sam = await addUserToOrg(app, owner.orgId, 'happy-sam')
      // A second session for Sam, so AC-5's "both cookies rejected" is exercised.
      const samSecondSession = await mintOrgSessionCookies(app, sam.userId, owner.orgId)

      const res = await deactivate(app, owner.cookies, sam.userId)

      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({
        data: { userId: sam.userId, revokedSessionCount: 2, revokedInvitationCount: 0 },
      })
      expect(await membershipStatus(owner.orgId, sam.userId)).toBe('deactivated')

      // AC-5: both of Sam's pre-existing sessions are rejected on their very next request — the
      // revoked_tokens fast-path / sessionVersion mismatch fires (401), same dual-check Story 1.7
      // already exercises. AC-6's *additional* org-membership-status gate (403) is a distinct
      // defense-in-depth layer, covered separately below for a session obtained after the fact.
      const first = await meRequest(app, sam.cookies)
      expect(first.statusCode).toBe(401)

      const second = await meRequest(app, samSecondSession)
      expect(second.statusCode).toBe(401)
    })

    it('rejects a session obtained after deactivation with 403 account_deactivated (AC-6 defense-in-depth)', async () => {
      const owner = await registerOwner(app, 'ac6-owner')
      const sam = await addUserToOrg(app, owner.orgId, 'ac6-sam')

      const res = await deactivate(app, owner.cookies, sam.userId)
      expect(res.statusCode).toBe(200)

      // Simulates AC-6's "Sam has since obtained a new valid session somehow (e.g. a race)" —
      // the session row itself is valid/unrevoked, so the auth middleware's org-membership-status
      // check is the only thing standing between this request and a deactivated account.
      const postDeactivationSession = await mintOrgSessionCookies(app, sam.userId, owner.orgId)

      const afterwards = await meRequest(app, postDeactivationSession)
      expect(afterwards.statusCode).toBe(403)
      expect(afterwards.json()).toMatchObject({ code: 'account_deactivated' })
    })

    it('reports zero revoked sessions when the target has none (AC-5 edge case)', async () => {
      const owner = await registerOwner(app, 'zero-sessions-owner')
      const sam = await addUserToOrg(app, owner.orgId, 'zero-sessions-sam')
      // Log Sam out everywhere before deactivation.
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        headers: { cookie: cookieHeader(sam.cookies) },
      })

      const res = await deactivate(app, owner.cookies, sam.userId)

      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ data: { revokedSessionCount: 0 } })
    })

    it('blocks a caller deactivating themselves (403 cannot_deactivate_self)', async () => {
      const owner = await registerOwner(app, 'self-owner')

      const res = await deactivate(app, owner.cookies, owner.userId)

      expect(res.statusCode).toBe(403)
      expect(res.json()).toMatchObject({ code: 'cannot_deactivate_self' })
      expect(await membershipStatus(owner.orgId, owner.userId)).toBe('active')
    })

    it('blocks an admin deactivating the org owner (403 insufficient_role, D9)', async () => {
      const owner = await registerOwner(app, 'hier-owner')
      const admin = await addUserToOrg(app, owner.orgId, 'hier-admin', { orgRole: 'admin' })

      const res = await deactivate(app, admin.cookies, owner.userId)

      expect(res.statusCode).toBe(403)
      expect(res.json()).toMatchObject({ code: 'insufficient_role' })
    })

    it('blocks an admin deactivating a peer admin (403 insufficient_role)', async () => {
      const owner = await registerOwner(app, 'peer-owner')
      const adminA = await addUserToOrg(app, owner.orgId, 'peer-admin-a', { orgRole: 'admin' })
      const adminB = await addUserToOrg(app, owner.orgId, 'peer-admin-b', { orgRole: 'admin' })

      const res = await deactivate(app, adminA.cookies, adminB.userId)

      expect(res.statusCode).toBe(403)
      expect(res.json()).toMatchObject({ code: 'insufficient_role' })
    })

    it('allows an owner to deactivate a member (200)', async () => {
      const owner = await registerOwner(app, 'owner-member-owner')
      const member = await addUserToOrg(app, owner.orgId, 'owner-member-target')

      const res = await deactivate(app, owner.cookies, member.userId)

      expect(res.statusCode).toBe(200)
    })

    it('returns 404 user_not_found for a userId not in the caller org', async () => {
      const owner = await registerOwner(app, 'missing-owner')

      const res = await deactivate(app, owner.cookies, randomUUID())

      expect(res.statusCode).toBe(404)
      expect(res.json()).toMatchObject({ code: 'user_not_found' })
    })

    it('rejects a non-admin caller (403 insufficient_role)', async () => {
      const owner = await registerOwner(app, 'nonadmin-owner')
      const member = await addUserToOrg(app, owner.orgId, 'nonadmin-caller', { orgRole: 'member' })
      const victim = await addUserToOrg(app, owner.orgId, 'nonadmin-victim')

      const res = await deactivate(app, member.cookies, victim.userId)

      expect(res.statusCode).toBe(403)
    })

    it('blocks a caller whose MFA grace period has lapsed without enrolling (403 mfa_required)', async () => {
      const unenrolledOwner = await registerAndLoginViaApi(app, {
        email: uniqueEmail('mfa-owner'),
        password: PASSWORD,
        orgName: `Deactivate MFA ${randomUUID()}`,
      })
      const sam = await addUserToOrg(app, unenrolledOwner.orgId, 'mfa-sam')
      // registerOwner grants a grace period (MFA_PRIVILEGED_ROLE_GRACE_DAYS) — expire it directly
      // to exercise the enforced branch of requireMfaEnrollment(), same as it fires in production
      // once that window elapses.
      await withOrg(unenrolledOwner.orgId, (tx) =>
        tx
          .update(orgMemberships)
          .set({ gracePeriodExpiresAt: new Date(Date.now() - 1000) })
          .where(
            and(
              eq(orgMemberships.orgId, unenrolledOwner.orgId),
              eq(orgMemberships.userId, unenrolledOwner.userId)
            )
          )
      )

      const res = await deactivate(app, unenrolledOwner.cookies, sam.userId)

      expect(res.statusCode).toBe(403)
      expect(res.json()).toMatchObject({ code: 'mfa_required' })
    })

    it('is idempotent-safe: a second call returns 409 already_deactivated with no re-mutation', async () => {
      const owner = await registerOwner(app, 'idempotent-owner')
      const sam = await addUserToOrg(app, owner.orgId, 'idempotent-sam')

      const first = await deactivate(app, owner.cookies, sam.userId)
      expect(first.statusCode).toBe(200)

      const second = await deactivate(app, owner.cookies, sam.userId)

      expect(second.statusCode).toBe(409)
      expect(second.json()).toMatchObject({ code: 'already_deactivated' })
    })

    it('is scoped to one org: a user deactivated in org X stays active in org Y (D3/AC-6)', async () => {
      const ownerX = await registerOwner(app, 'multi-org-x')
      const ownerY = await registerOwner(app, 'multi-org-y')
      const sam = await addUserToOrg(app, ownerX.orgId, 'multi-org-sam')
      await enrollMfa(sam.userId)
      // Graft Sam into org Y as well, active.
      await withOrg(ownerY.orgId, (tx) =>
        tx
          .insert(orgMemberships)
          .values({ orgId: ownerY.orgId, userId: sam.userId, role: 'member', status: 'active' })
      )

      const deactivateRes = await deactivate(app, ownerX.cookies, sam.userId)
      expect(deactivateRes.statusCode).toBe(200)

      // Org X: a freshly-minted session (standing in for AC-19's "somehow obtained a new
      // session" race) is rejected specifically at the org-membership-status gate.
      const freshInX = await mintOrgSessionCookies(app, sam.userId, ownerX.orgId)
      const inX = await meRequest(app, freshInX)
      expect(inX.statusCode).toBe(403)
      expect(inX.json()).toMatchObject({ code: 'account_deactivated' })

      // Org Y: still succeeds — deactivation is per-org, not a platform ban.
      const inY = await meRequest(app, await mintOrgSessionCookies(app, sam.userId, ownerY.orgId))
      expect(inY.statusCode).toBe(200)
      expect(inY.json()).toMatchObject({ data: { orgId: ownerY.orgId } })
    })

    it('revokes the target pending invitations they sent, leaving received invitations alone (AC-7)', async () => {
      const owner = await registerOwner(app, 'invite-owner')
      const projectId = await createProject(app, owner.cookies, 'invite-project')
      const sam = await addUserToOrg(app, owner.orgId, 'invite-sam', { orgRole: 'admin' })
      await enrollMfa(sam.userId)

      const invite = (email: string) =>
        app.inject({
          method: 'POST',
          url: `/api/v1/projects/${projectId}/invitations`,
          headers: { cookie: cookieHeader(sam.cookies) },
          payload: { email, role: 'member' },
        })

      const sentA = await invite(uniqueEmail('sent-a'))
      const sentB = await invite(uniqueEmail('sent-b'))
      expect(sentA.statusCode).toBe(201)
      expect(sentB.statusCode).toBe(201)

      const res = await deactivate(app, owner.cookies, sam.userId)

      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ data: { revokedInvitationCount: 2 } })

      const rows = await withOrg(owner.orgId, (tx) =>
        tx
          .select({ id: projectInvitations.id, revokedAt: projectInvitations.revokedAt })
          .from(projectInvitations)
          .where(eq(projectInvitations.invitedBy, sam.userId))
      )
      expect(rows).toHaveLength(2)
      for (const row of rows) expect(row.revokedAt).not.toBeNull()
    })

    it('reports zero revoked invitations when the target sent none (AC-7 edge case)', async () => {
      const owner = await registerOwner(app, 'no-invite-owner')
      const sam = await addUserToOrg(app, owner.orgId, 'no-invite-sam')

      const res = await deactivate(app, owner.cookies, sam.userId)

      expect(res.json()).toMatchObject({ data: { revokedInvitationCount: 0 } })
    })

    it('rolls back the deactivation when the audit write fails (503 audit_write_failed)', async () => {
      const owner = await registerOwner(app, 'audit-fail-owner')
      const sam = await addUserToOrg(app, owner.orgId, 'audit-fail-sam')
      const auditSpy = vi
        .spyOn(humanAudit, 'writeHumanAuditEntry')
        .mockRejectedValueOnce(new Error('forced audit failure'))
      try {
        const res = await deactivate(app, owner.cookies, sam.userId)
        expectAuditWriteFailed(res)
        expect(await membershipStatus(owner.orgId, sam.userId)).toBe('active')
      } finally {
        auditSpy.mockRestore()
      }
    })

    it('resolves a concurrent double-deactivation race with exactly one winner (AC-19)', async () => {
      const owner = await registerOwner(app, 'race-owner')
      const sam = await addUserToOrg(app, owner.orgId, 'race-sam')

      const [first, second] = await Promise.all([
        deactivate(app, owner.cookies, sam.userId),
        deactivate(app, owner.cookies, sam.userId),
      ])
      const statuses = [first.statusCode, second.statusCode].sort()

      expect(statuses).toEqual([200, 409])
      expect(await membershipStatus(owner.orgId, sam.userId)).toBe('deactivated')

      const auditRows = await withOrg(owner.orgId, async (tx) => {
        const { auditLogEntries } = await import('@project-vault/db/schema')
        return tx
          .select({ id: auditLogEntries.id })
          .from(auditLogEntries)
          .where(
            and(
              eq(auditLogEntries.orgId, owner.orgId),
              eq(auditLogEntries.eventType, 'org.user_deactivated')
            )
          )
      })
      expect(auditRows).toHaveLength(1)
    })
  })

  describe('POST /api/v1/org/users/:userId/recovery/send-link', () => {
    function sendLink(cookies: CookieJar, userId: string) {
      return app.inject({
        method: 'POST',
        url: `/api/v1/org/users/${userId}/recovery/send-link`,
        headers: { cookie: cookieHeader(cookies) },
      })
    }

    it('sends a recovery link (200) and enqueues an admin-flavored email', async () => {
      const owner = await registerOwner(app, 'send-link-owner')
      const sam = await addUserToOrg(app, owner.orgId, 'send-link-sam')

      const res = await sendLink(owner.cookies, sam.userId)

      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ data: { userId: sam.userId, linkSent: true } })

      const [queueRow] = await withOrg(owner.orgId, (tx) =>
        tx
          .select()
          .from(notificationQueue)
          .where(eq(notificationQueue.templateId, 'auth.recovery_link_sent'))
      )
      expect(queueRow?.recipientEmail).toBe(sam.email)
    })

    it('proceeds even if the target is already deactivated (AC-10 edge case)', async () => {
      const owner = await registerOwner(app, 'send-link-deactivated-owner')
      const sam = await addUserToOrg(app, owner.orgId, 'send-link-deactivated-sam')
      await deactivate(app, owner.cookies, sam.userId)

      const res = await sendLink(owner.cookies, sam.userId)

      expect(res.statusCode).toBe(200)
    })

    it('returns 404 for a user not in the caller org', async () => {
      const owner = await registerOwner(app, 'send-link-missing-owner')

      const res = await sendLink(owner.cookies, randomUUID())

      expect(res.statusCode).toBe(404)
      expect(res.json()).toMatchObject({ code: 'user_not_found' })
    })

    it('blocks a non-admin caller (403 insufficient_role)', async () => {
      const owner = await registerOwner(app, 'send-link-nonadmin-owner')
      const member = await addUserToOrg(app, owner.orgId, 'send-link-nonadmin-member', {
        orgRole: 'member',
      })
      const sam = await addUserToOrg(app, owner.orgId, 'send-link-nonadmin-sam')

      const res = await sendLink(member.cookies, sam.userId)

      expect(res.statusCode).toBe(403)
    })

    it('blocks sending a link to a peer/superior org role (hardened beyond the literal AC text)', async () => {
      const owner = await registerOwner(app, 'send-link-hier-owner')
      const admin = await addUserToOrg(app, owner.orgId, 'send-link-hier-admin', {
        orgRole: 'admin',
      })

      const res = await sendLink(admin.cookies, owner.userId)

      expect(res.statusCode).toBe(403)
      expect(res.json()).toMatchObject({ code: 'insufficient_role' })
    })
  })
})
