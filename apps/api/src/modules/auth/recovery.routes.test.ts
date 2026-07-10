import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'
import { getDb, withOrg } from '@project-vault/db'
import {
  accountRecoveryTokens,
  auditLogEntries,
  mfaEnrollments,
  mfaRecoveryCodes,
  notificationQueue,
  orgMemberships,
  userIdentityTokens,
  users,
} from '@project-vault/db/schema'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  expectAuditWriteFailed,
  mintOrgSessionCookies,
  registerAndLoginViaApi,
} from '../../__tests__/helpers/auth-test-helpers.js'
import {
  MEMBERSHIP_TEST_LOGIN_SECRET as PASSWORD,
  createMembershipTestHelpers,
} from '../../__tests__/helpers/membership-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import { bootProjectRouteTestApp } from '../projects/project-route-test-bootstrap.js'
import { totpForSecret } from '../../__tests__/helpers/totp.js'

const { createApp, initVault, humanAudit } = await bootstrapRouteIntegrationTest()

type TestApp = Awaited<ReturnType<typeof createApp>>

const RECOVERY_LINK_CREATED_TEMPLATE = 'auth.recovery_link_created'

const { uniqueEmail, enrollMfa } = createMembershipTestHelpers({
  emailPrefix: 'recovery',
  orgNamePrefix: 'Recovery',
})

/**
 * createMembershipTestHelpers' own registerOwner() (used by the sibling deactivation suite)
 * returns {userId, orgId, cookies} — no email, since that suite never needs it. This story's
 * tests key almost everything off the owner's email (recovery is email-addressed), so this local
 * wrapper captures it alongside the same registration + MFA-enrollment steps.
 */
async function registerOwnerWithEmail(app: TestApp, label: string) {
  const email = uniqueEmail(label)
  const user = await registerAndLoginViaApi(app, {
    email,
    password: PASSWORD,
    orgName: `Recovery ${label} ${randomUUID()}`,
  })
  await enrollMfa(user.userId)
  return { ...user, email }
}

function requestRecovery(app: TestApp, email: string, remoteAddress?: string) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/auth/recovery/request',
    payload: { email },
    ...(remoteAddress ? { remoteAddress } : {}),
  })
}

function peek(app: TestApp, token: string) {
  return app.inject({ method: 'GET', url: `/api/v1/auth/recovery/${encodeURIComponent(token)}` })
}

function mfaStart(app: TestApp, token: string) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/auth/recovery/${encodeURIComponent(token)}/mfa/start`,
  })
}

function complete(app: TestApp, token: string, body: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/auth/recovery/${encodeURIComponent(token)}/complete`,
    payload: body,
  })
}

async function clearRateLimitBucketsFor(keys: string[]): Promise<void> {
  for (const key of keys) {
    await getDb().execute(sql`DELETE FROM auth_rate_limit_buckets WHERE bucket_key = ${key}`)
  }
}

async function tokenRowForUser(userId: string) {
  const [row] = await getDb()
    .select()
    .from(accountRecoveryTokens)
    .where(eq(accountRecoveryTokens.userId, userId))
    .orderBy(sql`created_at desc`)
    .limit(1)
  return row
}

async function opaqueTokenFromQueue(
  orgId: string,
  recipientEmail: string,
  templateId: string
): Promise<string> {
  // notification_queue is RLS-scoped — an ad-hoc getDb() query outside any org context would
  // silently see zero rows (RLS filters on a NULL app.current_org_id), not an error.
  const [row] = await withOrg(orgId, (tx) =>
    tx
      .select({ payload: notificationQueue.payload })
      .from(notificationQueue)
      .where(
        and(
          eq(notificationQueue.recipientEmail, recipientEmail),
          eq(notificationQueue.templateId, templateId)
        )
      )
      .orderBy(sql`created_at desc`)
      .limit(1)
  )
  const payload = row?.payload as { recoveryUrl?: string } | undefined
  const url = payload?.recoveryUrl
  if (!url) throw new Error(`no recovery email queued for ${recipientEmail}`)
  const match = /\/recovery\/([^/?]+)/.exec(url)
  if (!match?.[1]) throw new Error(`could not extract token from ${url}`)
  return match[1]
}

async function auditRowsFor(orgId: string, eventType: string) {
  return withOrg(orgId, (tx) =>
    tx
      .select({ id: auditLogEntries.id, actorTokenId: auditLogEntries.actorTokenId })
      .from(auditLogEntries)
      .where(and(eq(auditLogEntries.orgId, orgId), eq(auditLogEntries.eventType, eventType)))
  )
}

describe.sequential('account recovery routes', () => {
  let app: TestApp

  beforeAll(async () => {
    app = await bootProjectRouteTestApp(createApp, initVault)
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  it('registers every recovery route in the OpenAPI document (AC-17)', async () => {
    await app.ready()
    const document = app.swagger() as { paths?: Record<string, unknown> }

    expect(document.paths?.['/api/v1/auth/recovery/request']).toBeDefined()
    expect(document.paths?.['/api/v1/auth/recovery/{token}']).toBeDefined()
    expect(document.paths?.['/api/v1/auth/recovery/{token}/mfa/start']).toBeDefined()
    expect(document.paths?.['/api/v1/auth/recovery/{token}/complete']).toBeDefined()
  })

  describe('POST /api/v1/auth/recovery/request', () => {
    it('creates a token, enqueues a self-flavored email, and audits per active org membership (AC-9)', async () => {
      const owner = await registerOwnerWithEmail(app, 'req-owner')
      const remoteAddress = `10.9.${randomUUID().slice(0, 2)}.1`

      const res = await requestRecovery(app, owner.email, remoteAddress)

      expect(res.statusCode).toBe(202)
      expect(res.json()).toEqual({ message: expect.any(String) })

      const tokenRow = await tokenRowForUser(owner.userId)
      expect(tokenRow).toBeDefined()
      expect(tokenRow?.initiatedBy).toBe('self')
      expect(tokenRow?.usedAt).toBeNull()

      const [queueRow] = await withOrg(owner.orgId, (tx) =>
        tx
          .select()
          .from(notificationQueue)
          .where(
            and(
              eq(notificationQueue.recipientEmail, owner.email),
              eq(notificationQueue.templateId, RECOVERY_LINK_CREATED_TEMPLATE)
            )
          )
      )
      expect(queueRow).toBeDefined()

      const auditRows = await auditRowsFor(owner.orgId, 'auth.recovery_requested')
      expect(auditRows).toHaveLength(1)
    })

    it('returns the identical generic response for an email that does not exist (AC-9/AC-11 anti-enumeration)', async () => {
      const remoteAddress = `10.9.${randomUUID().slice(0, 2)}.2`
      const res = await requestRecovery(app, uniqueEmail('nobody-here'), remoteAddress)

      expect(res.statusCode).toBe(202)
      expect(res.json()).toEqual({ message: expect.any(String) })
    })

    it('supersedes a prior unused token when a new one is requested (AC-9 step 3 / AC-13)', async () => {
      const owner = await registerOwnerWithEmail(app, 'supersede-owner')
      const remoteAddress = `10.9.${randomUUID().slice(0, 2)}.3`

      await requestRecovery(app, owner.email, remoteAddress)
      const firstToken = await tokenRowForUser(owner.userId)
      expect(firstToken).toBeDefined()

      await requestRecovery(app, owner.email, remoteAddress)
      const secondToken = await tokenRowForUser(owner.userId)

      expect(secondToken?.id).not.toBe(firstToken?.id)
      const [refreshedFirst] = await getDb()
        .select({ supersededAt: accountRecoveryTokens.supersededAt })
        .from(accountRecoveryTokens)
        .where(eq(accountRecoveryTokens.id, firstToken?.id as string))
      expect(refreshedFirst?.supersededAt).not.toBeNull()
    })

    it('returns 404 no_admin_available when the user has no reachable org admin (AC-12)', async () => {
      const owner = await registerOwnerWithEmail(app, 'noadmin-owner')
      // addUserToOrg grafts the new user into owner.orgId *in addition to* auto-creating their
      // own personal org (where they're 'owner') — which would give them a reachable admin via
      // that other org (AC-12's own "belongs to 2 orgs, one with an admin" edge case correctly
      // succeeds, not blocks). To get the single-org "nobody can help" state this AC actually
      // targets, insert the member directly with no org of their own.
      const memberEmail = uniqueEmail('noadmin-member')
      const [memberUser] = await getDb()
        .insert(users)
        .values({ email: memberEmail, passwordHash: 'unused-in-this-test' })
        .returning({ id: users.id })
      expect(memberUser).toBeDefined()
      // Code-review finding (Story 8.1): a real user_identity_tokens row, incidental to what
      // this test actually exercises (the no-reachable-admin 404 path) but required so the
      // resulting auth.recovery_blocked_no_admin audit row doesn't permanently fail
      // checkAuditActorTokenCoverage (packages/db/src/check-audit-actor-token-coverage.ts).
      await getDb()
        .insert(userIdentityTokens)
        .values({ userId: memberUser?.id as string, displayName: memberEmail })
      await withOrg(owner.orgId, (tx) =>
        tx.insert(orgMemberships).values({
          orgId: owner.orgId,
          userId: memberUser?.id as string,
          role: 'member',
          status: 'active',
        })
      )
      // Simulate the documented edge state: the org's sole owner's membership becomes
      // non-active through a path other than self-deactivation (AC-3 blocks that directly).
      await withOrg(owner.orgId, (tx) =>
        tx
          .update(orgMemberships)
          .set({ status: 'deactivated' })
          .where(
            and(eq(orgMemberships.orgId, owner.orgId), eq(orgMemberships.userId, owner.userId))
          )
      )
      const remoteAddress = `10.9.${randomUUID().slice(0, 2)}.4`

      const res = await requestRecovery(app, memberEmail, remoteAddress)

      expect(res.statusCode).toBe(404)
      expect(res.json()).toMatchObject({ code: 'no_admin_available' })

      const auditRows = await auditRowsFor(owner.orgId, 'auth.recovery_blocked_no_admin')
      expect(auditRows).toHaveLength(1)
      // Code-review finding (Story 8.1): this fixture used to insert memberUser with no backing
      // user_identity_tokens row, incidental to what this test actually exercises (the
      // no-reachable-admin 404 path) — writeHumanAuditEntryOrFailClosed correctly, faithfully
      // reported that real absence as actor_token_id: null, permanently failing
      // checkAuditActorTokenCoverage (audit_log_entries is append-only, never cleaned up between
      // test runs).
      expect(auditRows[0]?.actorTokenId).not.toBeNull()
    })

    it('rate-limits by IP after 10 requests (429, AC-11)', async () => {
      const ip = `10.11.${randomUUID().slice(0, 2)}.99`
      await clearRateLimitBucketsFor([`ip:${ip}`])

      const responses: number[] = []
      for (let i = 0; i < 11; i += 1) {
        const res = await requestRecovery(app, uniqueEmail(`iplimit-${i}`), ip)
        responses.push(res.statusCode)
      }

      expect(responses.slice(0, 10).every((code) => code === 202 || code === 404)).toBe(true)
      expect(responses[10]).toBe(429)
    })

    it('rate-limits by normalized email after 5 requests (429, AC-11)', async () => {
      const email = uniqueEmail('emaillimit')
      await clearRateLimitBucketsFor([`email:${email}`])

      const responses: number[] = []
      for (let i = 0; i < 6; i += 1) {
        const res = await requestRecovery(app, email, `10.12.${randomUUID().slice(0, 2)}.${i}`)
        responses.push(res.statusCode)
      }

      expect(responses.slice(0, 5).every((code) => code === 202)).toBe(true)
      expect(responses[5]).toBe(429)
    })

    it('rolls back token creation when the audit write fails (503 audit_write_failed, AC-16)', async () => {
      const owner = await registerOwnerWithEmail(app, 'req-audit-fail-owner')
      const remoteAddress = `10.9.${randomUUID().slice(0, 2)}.5`
      const auditSpy = vi
        .spyOn(humanAudit, 'writeHumanAuditEntry')
        .mockRejectedValueOnce(new Error('forced audit failure'))
      try {
        const res = await requestRecovery(app, owner.email, remoteAddress)
        expectAuditWriteFailed(res)
        expect(await tokenRowForUser(owner.userId)).toBeUndefined()
      } finally {
        auditSpy.mockRestore()
      }
    })
  })

  describe('GET /api/v1/auth/recovery/:token', () => {
    it('returns a masked email and MFA status for a valid token (AC-13)', async () => {
      const owner = await registerOwnerWithEmail(app, 'peek-owner')
      const remoteAddress = `10.9.${randomUUID().slice(0, 2)}.6`
      await requestRecovery(app, owner.email, remoteAddress)
      const token = await opaqueTokenFromQueue(
        owner.orgId,
        owner.email,
        RECOVERY_LINK_CREATED_TEMPLATE
      )

      const res = await peek(app, token)

      expect(res.statusCode).toBe(200)
      const body = res.json<{ data: { email: string; mfaCurrentlyEnrolled: boolean } }>()
      expect(body.data.email).toMatch(/^.{1,2}\*\*\*@/)
      expect(body.data.email).not.toBe(owner.email)
      // registerOwnerWithEmail enrolls MFA as part of setup (most of this file's other tests
      // depend on that for their own MFA-gated routes) — so the owner is already enrolled here.
      expect(body.data.mfaCurrentlyEnrolled).toBe(true)
    })

    it('returns 404 recovery_token_not_found for an unknown token', async () => {
      const res = await peek(app, 'not-a-real-token')
      expect(res.statusCode).toBe(404)
      expect(res.json()).toMatchObject({ code: 'recovery_token_not_found' })
    })

    it('returns 410 recovery_token_expired for an expired token', async () => {
      const owner = await registerOwnerWithEmail(app, 'peek-expired-owner')
      const remoteAddress = `10.9.${randomUUID().slice(0, 2)}.7`
      await requestRecovery(app, owner.email, remoteAddress)
      const token = await opaqueTokenFromQueue(
        owner.orgId,
        owner.email,
        RECOVERY_LINK_CREATED_TEMPLATE
      )
      await getDb()
        .update(accountRecoveryTokens)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(accountRecoveryTokens.userId, owner.userId))

      const res = await peek(app, token)

      expect(res.statusCode).toBe(410)
      expect(res.json()).toMatchObject({ code: 'recovery_token_expired' })
    })

    it('returns 409 recovery_token_used for an already-completed token', async () => {
      const owner = await registerOwnerWithEmail(app, 'peek-used-owner')
      const remoteAddress = `10.9.${randomUUID().slice(0, 2)}.8`
      await requestRecovery(app, owner.email, remoteAddress)
      const token = await opaqueTokenFromQueue(
        owner.orgId,
        owner.email,
        RECOVERY_LINK_CREATED_TEMPLATE
      )

      const completeRes = await complete(app, token, { newPassword: 'brand-new-password-9!' })
      expect(completeRes.statusCode).toBe(200)

      const res = await peek(app, token)
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ code: 'recovery_token_used' })
    })

    it('returns 410 recovery_token_superseded for a superseded token', async () => {
      const owner = await registerOwnerWithEmail(app, 'peek-superseded-owner')
      const remoteAddress = `10.9.${randomUUID().slice(0, 2)}.9`
      await requestRecovery(app, owner.email, remoteAddress)
      const firstToken = await opaqueTokenFromQueue(
        owner.orgId,
        owner.email,
        RECOVERY_LINK_CREATED_TEMPLATE
      )
      await requestRecovery(app, owner.email, remoteAddress)

      const res = await peek(app, firstToken)

      expect(res.statusCode).toBe(410)
      expect(res.json()).toMatchObject({ code: 'recovery_token_superseded' })
    })
  })

  describe('POST /api/v1/auth/recovery/:token/complete', () => {
    it('resets the password, revokes sessions, and issues no new session (AC-14)', async () => {
      const owner = await registerOwnerWithEmail(app, 'complete-owner')
      const extraSession = await mintOrgSessionCookies(app, owner.userId, owner.orgId)
      const remoteAddress = `10.9.${randomUUID().slice(0, 2)}.10`
      await requestRecovery(app, owner.email, remoteAddress)
      const token = await opaqueTokenFromQueue(
        owner.orgId,
        owner.email,
        RECOVERY_LINK_CREATED_TEMPLATE
      )

      const res = await complete(app, token, { newPassword: 'a-brand-new-password-1!' })

      expect(res.statusCode).toBe(200)
      const body = res.json<{
        data: { email: string; sessionsRevoked: number; mfaReEnrolled: boolean }
      }>()
      expect(body.data.email).toBe(owner.email)
      expect(body.data.sessionsRevoked).toBeGreaterThanOrEqual(2)
      expect(body.data.mfaReEnrolled).toBe(false)
      expect(res.headers['set-cookie']).toBeUndefined()

      // Old session cookie must now be rejected.
      const stale = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { cookie: cookieHeader(extraSession) },
      })
      expect(stale.statusCode).toBe(401)

      // New password logs in successfully.
      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: owner.email, password: 'a-brand-new-password-1!' },
      })
      expect(login.statusCode).toBe(200)
    })

    it('reports zero sessions revoked when none exist (AC-14 edge case)', async () => {
      const owner = await registerOwnerWithEmail(app, 'complete-zero-owner')
      const remoteAddress = `10.9.${randomUUID().slice(0, 2)}.11`
      await requestRecovery(app, owner.email, remoteAddress)
      const token = await opaqueTokenFromQueue(
        owner.orgId,
        owner.email,
        RECOVERY_LINK_CREATED_TEMPLATE
      )
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        headers: { cookie: cookieHeader(owner.cookies) },
      })

      const res = await complete(app, token, { newPassword: 'a-brand-new-password-2!' })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ data: { sessionsRevoked: 0 } })
    })

    it('rejects a weak password without consuming the token (422, AC-14 edge case)', async () => {
      const owner = await registerOwnerWithEmail(app, 'complete-weak-owner')
      const remoteAddress = `10.9.${randomUUID().slice(0, 2)}.12`
      await requestRecovery(app, owner.email, remoteAddress)
      const token = await opaqueTokenFromQueue(
        owner.orgId,
        owner.email,
        RECOVERY_LINK_CREATED_TEMPLATE
      )

      const weak = await complete(app, token, { newPassword: 'short' })
      expect(weak.statusCode).toBe(422)

      const retry = await complete(app, token, { newPassword: 'a-strong-enough-password-3!' })
      expect(retry.statusCode).toBe(200)
    })

    it('returns 409 recovery_token_used for a token completed twice sequentially', async () => {
      const owner = await registerOwnerWithEmail(app, 'complete-reused-owner')
      const remoteAddress = `10.9.${randomUUID().slice(0, 2)}.13`
      await requestRecovery(app, owner.email, remoteAddress)
      const token = await opaqueTokenFromQueue(
        owner.orgId,
        owner.email,
        RECOVERY_LINK_CREATED_TEMPLATE
      )

      const first = await complete(app, token, { newPassword: 'a-strong-enough-password-4!' })
      expect(first.statusCode).toBe(200)

      // The pre-transaction status check (AC-13's status taxonomy) already sees usedAt set by
      // the first call and rejects here — recovery_token_already_used (AC-19) is reserved for
      // the narrower concurrent-race window where both calls pass that check before either
      // commits (covered separately below).
      const second = await complete(app, token, { newPassword: 'another-strong-password-5!' })
      expect(second.statusCode).toBe(409)
      expect(second.json()).toMatchObject({ code: 'recovery_token_used' })
    })

    it('resolves a concurrent double-completion race with exactly one winner (AC-19)', async () => {
      const owner = await registerOwnerWithEmail(app, 'complete-race-owner')
      const remoteAddress = `10.9.${randomUUID().slice(0, 2)}.14`
      await requestRecovery(app, owner.email, remoteAddress)
      const token = await opaqueTokenFromQueue(
        owner.orgId,
        owner.email,
        RECOVERY_LINK_CREATED_TEMPLATE
      )

      const [a, b] = await Promise.all([
        complete(app, token, { newPassword: 'race-password-one-6!' }),
        complete(app, token, { newPassword: 'race-password-two-7!' }),
      ])
      const statuses = [a.statusCode, b.statusCode].sort()

      expect(statuses).toEqual([200, 409])
    })

    it('rolls back completion when the audit write fails (503 audit_write_failed, AC-16)', async () => {
      const owner = await registerOwnerWithEmail(app, 'complete-audit-fail-owner')
      const remoteAddress = `10.9.${randomUUID().slice(0, 2)}.15`
      await requestRecovery(app, owner.email, remoteAddress)
      const token = await opaqueTokenFromQueue(
        owner.orgId,
        owner.email,
        RECOVERY_LINK_CREATED_TEMPLATE
      )
      const auditSpy = vi
        .spyOn(humanAudit, 'writeHumanAuditEntry')
        .mockRejectedValueOnce(new Error('forced audit failure'))
      try {
        const res = await complete(app, token, { newPassword: 'audit-fail-password-8!' })
        expectAuditWriteFailed(res)
      } finally {
        auditSpy.mockRestore()
      }

      // Token was not durably consumed by the rolled-back attempt — retry succeeds.
      const retry = await complete(app, token, { newPassword: 'audit-fail-password-retry-9!' })
      expect(retry.statusCode).toBe(200)
    })
  })

  describe('POST /api/v1/auth/recovery/:token/mfa/start + complete with totpCode', () => {
    it('re-enrolls MFA in the same transaction as completion and issues fresh recovery codes (AC-15/D1, adversarial HIGH-1)', async () => {
      const owner = await registerOwnerWithEmail(app, 'mfa-owner')
      const remoteAddress = `10.9.${randomUUID().slice(0, 2)}.16`
      await requestRecovery(app, owner.email, remoteAddress)
      const token = await opaqueTokenFromQueue(
        owner.orgId,
        owner.email,
        RECOVERY_LINK_CREATED_TEMPLATE
      )

      const start = await mfaStart(app, token)
      expect(start.statusCode).toBe(200)
      const { secret } = start.json<{ data: { secret: string } }>().data

      const res = await complete(app, token, {
        newPassword: 'mfa-recovery-password-10!',
        totpCode: totpForSecret(secret),
      })

      expect(res.statusCode).toBe(200)
      const body = res.json<{
        data: { mfaReEnrolled: boolean; recoveryCodes?: string[] }
      }>()
      expect(body.data.mfaReEnrolled).toBe(true)
      expect(body.data.recoveryCodes?.length).toBeGreaterThan(0)

      const [confirmed] = await getDb()
        .select({ status: mfaEnrollments.status })
        .from(mfaEnrollments)
        .where(and(eq(mfaEnrollments.userId, owner.userId), eq(mfaEnrollments.status, 'confirmed')))
      expect(confirmed).toBeDefined()

      const unusedCodes = await getDb()
        .select({ id: mfaRecoveryCodes.id })
        .from(mfaRecoveryCodes)
        .where(and(eq(mfaRecoveryCodes.userId, owner.userId), sql`used_at IS NULL`))
      expect(unusedCodes.length).toBeGreaterThan(0)
    })

    it('does not consume the token on mfa/start alone', async () => {
      const owner = await registerOwnerWithEmail(app, 'mfa-nostart-owner')
      const remoteAddress = `10.9.${randomUUID().slice(0, 2)}.17`
      await requestRecovery(app, owner.email, remoteAddress)
      const token = await opaqueTokenFromQueue(
        owner.orgId,
        owner.email,
        RECOVERY_LINK_CREATED_TEMPLATE
      )

      await mfaStart(app, token)
      const peekRes = await peek(app, token)

      expect(peekRes.statusCode).toBe(200)
    })

    it('returns 422 mfa_not_staged when totpCode is submitted without a prior mfa/start call', async () => {
      const owner = await registerOwnerWithEmail(app, 'mfa-notstaged-owner')
      const remoteAddress = `10.9.${randomUUID().slice(0, 2)}.18`
      await requestRecovery(app, owner.email, remoteAddress)
      const token = await opaqueTokenFromQueue(
        owner.orgId,
        owner.email,
        RECOVERY_LINK_CREATED_TEMPLATE
      )

      const res = await complete(app, token, {
        newPassword: 'unstaged-password-11!',
        totpCode: '123456',
      })

      expect(res.statusCode).toBe(422)
      expect(res.json()).toMatchObject({ code: 'mfa_not_staged' })
    })

    it('returns 422 invalid_totp_code for a wrong code and does not consume the token', async () => {
      const owner = await registerOwnerWithEmail(app, 'mfa-wrongcode-owner')
      const remoteAddress = `10.9.${randomUUID().slice(0, 2)}.19`
      await requestRecovery(app, owner.email, remoteAddress)
      const token = await opaqueTokenFromQueue(
        owner.orgId,
        owner.email,
        RECOVERY_LINK_CREATED_TEMPLATE
      )
      await mfaStart(app, token)

      const wrong = await complete(app, token, {
        newPassword: 'wrongcode-password-12!',
        totpCode: '000000',
      })
      expect(wrong.statusCode).toBe(422)
      expect(wrong.json()).toMatchObject({ code: 'invalid_totp_code' })

      const stillValid = await peek(app, token)
      expect(stillValid.statusCode).toBe(200)
    })

    it('completes successfully without totpCode even after mfa/start was never called (AC-15 edge case)', async () => {
      const owner = await registerOwnerWithEmail(app, 'mfa-omit-owner')
      const remoteAddress = `10.9.${randomUUID().slice(0, 2)}.20`
      await requestRecovery(app, owner.email, remoteAddress)
      const token = await opaqueTokenFromQueue(
        owner.orgId,
        owner.email,
        RECOVERY_LINK_CREATED_TEMPLATE
      )

      const res = await complete(app, token, { newPassword: 'omit-mfa-password-13!' })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ data: { mfaReEnrolled: false } })
    })
  })
})
