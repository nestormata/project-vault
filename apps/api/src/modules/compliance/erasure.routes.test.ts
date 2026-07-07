import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { getDb, withOrg } from '@project-vault/db'
import { createTestUser } from '@project-vault/db/test-helpers'
import {
  accountRecoveryTokens,
  auditLogEntries,
  dataErasureRequests,
  mfaEnrollments,
  mfaRecoveryCodes,
  orgMemberships,
  sessions,
  userIdentityTokens,
  users,
} from '@project-vault/db/schema'
import { AuditEvent } from '@project-vault/shared'
import type { CookieJar } from '../../__tests__/helpers/auth-test-helpers.js'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  expectAuditWriteFailed,
  mintOrgSessionCookies,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { bootProjectRouteTestApp } from '../projects/project-route-test-bootstrap.js'
import { createMembershipTestHelpers } from '../../__tests__/helpers/membership-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'

const { createApp, initVault } = await bootstrapRouteIntegrationTest()

type TestApp = Awaited<ReturnType<typeof createApp>>

const { registerOwner, addUserToOrg, enrollMfa } = createMembershipTestHelpers({
  emailPrefix: 'erasure',
  orgNamePrefix: 'Erasure',
})

function createErasureRequest(
  app: TestApp,
  cookies: CookieJar,
  userId: string,
  body: Record<string, unknown> = {
    reason: 'GDPR Article 17 request',
    requestedBy: 'sam@example.com',
  }
) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/org/users/${userId}/erasure-request`,
    headers: { cookie: cookieHeader(cookies) },
    payload: body,
  })
}

function executeErasureRequest(
  app: TestApp,
  cookies: CookieJar,
  userId: string,
  requestId: string,
  body: Record<string, unknown> = { confirm: true }
) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/org/users/${userId}/erasure-request/${requestId}/execute`,
    headers: { cookie: cookieHeader(cookies) },
    payload: body,
  })
}

function getErasureReport(app: TestApp, cookies: CookieJar, userId: string, requestId: string) {
  return app.inject({
    method: 'GET',
    url: `/api/v1/org/users/${userId}/erasure-request/${requestId}/report`,
    headers: { cookie: cookieHeader(cookies) },
  })
}

/**
 * D2/AC-8: `addUserToOrg` (shared membership-test-helpers) always registers its user via a brand
 * new self-owned org first, then GRAFTS them into the target org — meaning that helper's users
 * always carry >= 2 org_memberships rows (their own org + the graft), which trips the D2
 * cross-org guard even in a plain single-org happy-path scenario. Execute-focused tests need a
 * target user whose *only* membership is the org under test, so this creates a bare user (no
 * self-owned org) and grafts exactly one org_memberships row directly.
 */
async function createSingleOrgMember(orgId: string, label: string): Promise<{ userId: string }> {
  const userId = await createTestUser(label)
  await withOrg(orgId, (tx) => tx.insert(orgMemberships).values({ orgId, userId, role: 'member' }))
  return { userId }
}

/** AC-5/AC-13: every one of the user's session rows (in this org) must have PII columns nulled
 * (D12) AND be revoked (D4/step 7) — pulled out of the calling test so that test's own cyclomatic
 * complexity stays under this repo's eslint threshold. */
function assertEverySessionScrubbedAndRevoked(
  rows: { ipAddress: string | null; userAgent: string | null; revokedAt: Date | null }[]
): void {
  for (const row of rows) {
    expect(row.ipAddress).toBeNull()
    expect(row.userAgent).toBeNull()
    expect(row.revokedAt).not.toBeNull()
  }
}

async function seedMfaAndSessionPii(orgId: string, userId: string) {
  await getDb()
    .insert(mfaEnrollments)
    .values({
      userId,
      secretEncrypted: { version: 1, iv: 'iv', ciphertext: 'ct', tag: 'tag' },
      status: 'confirmed',
      confirmedAt: new Date(),
    })
  await getDb()
    .insert(mfaRecoveryCodes)
    .values([
      { userId, codeHash: `used-${randomUUID()}`, usedAt: new Date() },
      { userId, codeHash: `unused-${randomUUID()}` },
    ])
}

describe.sequential('data subject erasure routes (Story 8.4)', () => {
  let app: TestApp

  beforeAll(async () => {
    app = await bootProjectRouteTestApp(createApp, initVault)
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  it('registers all three routes in the OpenAPI document (AC-22)', async () => {
    await app.ready()
    const document = app.swagger() as { paths?: Record<string, unknown> }
    expect(document.paths?.['/api/v1/org/users/{userId}/erasure-request']).toBeDefined()
    expect(
      document.paths?.['/api/v1/org/users/{userId}/erasure-request/{requestId}/execute']
    ).toBeDefined()
    expect(
      document.paths?.['/api/v1/org/users/{userId}/erasure-request/{requestId}/report']
    ).toBeDefined()
  })

  describe('POST /erasure-request (AC-1 through AC-4)', () => {
    it('creates a request and returns an accurate PII inventory (AC-1)', async () => {
      const owner = await registerOwner(app, 'ac1-owner')
      const sam = await addUserToOrg(app, owner.orgId, 'ac1-sam')
      await seedMfaAndSessionPii(owner.orgId, sam.userId)

      const res = await createErasureRequest(app, owner.cookies, sam.userId, {
        reason: 'GDPR Article 17 request received via support ticket #4821',
        requestedBy: 'Sam <sam@example.com> via privacy@example-org.com',
      })

      expect(res.statusCode).toBe(201)
      const body = res.json<{
        data: { requestId: string; status: string; piiInventory: { tables: unknown[] } }
      }>()
      expect(body.data.status).toBe('pending')
      const byTable = Object.fromEntries(
        (body.data.piiInventory.tables as { table: string; rowCount: number }[]).map((t) => [
          t.table,
          t.rowCount,
        ])
      )
      expect(byTable['users']).toBe(1)
      expect(byTable['user_identity_tokens']).toBe(1)
      expect(byTable['mfa_enrollments']).toBe(1)
      expect(byTable['mfa_recovery_codes']).toBe(2)
      expect(byTable['account_recovery_tokens']).toBe(0)
      expect(byTable['sessions']).toBe(1)

      const auditRows = await withOrg(owner.orgId, (tx) =>
        tx
          .select({ payload: auditLogEntries.payload, actorTokenId: auditLogEntries.actorTokenId })
          .from(auditLogEntries)
          .where(eq(auditLogEntries.eventType, AuditEvent.USER_ERASURE_REQUESTED))
      )
      expect(auditRows).toHaveLength(1)
      expect(auditRows[0]?.payload).toMatchObject({ dataErasureRequestId: body.data.requestId })
    })

    it.each(['member', 'viewer'])(
      'rejects a %s caller (403 insufficient_role, AC-2)',
      async (role) => {
        const owner = await registerOwner(app, `ac2-owner-${role}`)
        const caller = await addUserToOrg(app, owner.orgId, `ac2-caller-${role}`, { orgRole: role })
        const sam = await addUserToOrg(app, owner.orgId, `ac2-sam-${role}`)

        const res = await createErasureRequest(app, caller.cookies, sam.userId)

        expect(res.statusCode).toBe(403)
        expect(res.json()).toMatchObject({ code: 'insufficient_role' })
        const rows = await withOrg(owner.orgId, (tx) =>
          tx.select().from(dataErasureRequests).where(eq(dataErasureRequests.userId, sam.userId))
        )
        expect(rows).toHaveLength(0)
      }
    )

    it('allows an admin caller (201, AC-2/D7)', async () => {
      const owner = await registerOwner(app, 'ac2-admin-owner')
      const admin = await addUserToOrg(app, owner.orgId, 'ac2-admin-caller', { orgRole: 'admin' })
      await enrollMfa(admin.userId)
      const sam = await addUserToOrg(app, owner.orgId, 'ac2-admin-sam')

      const res = await createErasureRequest(app, admin.cookies, sam.userId)

      expect(res.statusCode).toBe(201)
    })

    it('returns 404 user_not_found for an unknown userId (AC-3)', async () => {
      const owner = await registerOwner(app, 'ac3-owner')

      const res = await createErasureRequest(app, owner.cookies, randomUUID())

      expect(res.statusCode).toBe(404)
      expect(res.json()).toMatchObject({ code: 'user_not_found' })
    })

    it('returns 404 user_not_found for a user who is only a member of a different org (AC-3)', async () => {
      const ownerA = await registerOwner(app, 'ac3-cross-a')
      const ownerB = await registerOwner(app, 'ac3-cross-b')
      const samInB = await addUserToOrg(app, ownerB.orgId, 'ac3-cross-sam')

      const res = await createErasureRequest(app, ownerA.cookies, samInB.userId)

      expect(res.statusCode).toBe(404)
      expect(res.json()).toMatchObject({ code: 'user_not_found' })
    })

    it('returns 409 erasure_request_already_pending with a freshly recomputed inventory on a duplicate call (AC-4)', async () => {
      const owner = await registerOwner(app, 'ac4-owner')
      const sam = await addUserToOrg(app, owner.orgId, 'ac4-sam')

      const first = await createErasureRequest(app, owner.cookies, sam.userId)
      expect(first.statusCode).toBe(201)
      const firstId = first.json<{ data: { requestId: string } }>().data.requestId

      const second = await createErasureRequest(app, owner.cookies, sam.userId)

      expect(second.statusCode).toBe(409)
      expect(second.json()).toMatchObject({
        code: 'erasure_request_already_pending',
        requestId: firstId,
      })
      const rows = await withOrg(owner.orgId, (tx) =>
        tx.select().from(dataErasureRequests).where(eq(dataErasureRequests.userId, sam.userId))
      )
      expect(rows).toHaveLength(1)
    })

    it('returns 410 user_already_erased when the existing request is already completed (AC-4 edge case)', async () => {
      const owner = await registerOwner(app, 'ac4-completed-owner')
      const sam = await createSingleOrgMember(owner.orgId, 'ac4-completed-sam')
      const created = await createErasureRequest(app, owner.cookies, sam.userId)
      const requestId = created.json<{ data: { requestId: string } }>().data.requestId
      const executed = await executeErasureRequest(app, owner.cookies, sam.userId, requestId)
      expect(executed.statusCode).toBe(200)

      const res = await createErasureRequest(app, owner.cookies, sam.userId)

      expect(res.statusCode).toBe(410)
      expect(res.json()).toMatchObject({ code: 'user_already_erased', requestId })
    })

    it('resolves a concurrent double-creation race with exactly one winning row (AC-4/D9)', async () => {
      const owner = await registerOwner(app, 'ac4-race-owner')
      const sam = await addUserToOrg(app, owner.orgId, 'ac4-race-sam')

      const [first, second] = await Promise.all([
        createErasureRequest(app, owner.cookies, sam.userId),
        createErasureRequest(app, owner.cookies, sam.userId),
      ])
      const statuses = [first.statusCode, second.statusCode].sort()
      expect(statuses).toEqual([201, 409])

      const rows = await withOrg(owner.orgId, (tx) =>
        tx.select().from(dataErasureRequests).where(eq(dataErasureRequests.userId, sam.userId))
      )
      expect(rows).toHaveLength(1)
    })
  })

  describe('POST /erasure-request/:requestId/execute (AC-5 through AC-13)', () => {
    async function seedAndExecuteHappyPathErasure(label: string) {
      const owner = await registerOwner(app, `${label}-owner`)
      const sam = await createSingleOrgMember(owner.orgId, `${label}-sam`)
      await mintOrgSessionCookies(app, sam.userId, owner.orgId)
      await seedMfaAndSessionPii(owner.orgId, sam.userId)
      await getDb()
        .insert(accountRecoveryTokens)
        .values({
          userId: sam.userId,
          tokenHash: `token-${randomUUID()}`,
          initiatedBy: 'self',
          expiresAt: new Date(Date.now() + 3600_000),
        })
      const [beforeUser] = await getDb()
        .select({ email: users.email, passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.id, sam.userId))

      const created = await createErasureRequest(app, owner.cookies, sam.userId)
      const requestId = created.json<{ data: { requestId: string } }>().data.requestId
      const res = await executeErasureRequest(app, owner.cookies, sam.userId, requestId)

      return { owner, sam, requestId, res, beforeUser }
    }

    it('executes the erasure and returns 200 with the documented response shape (AC-5)', async () => {
      const { res } = await seedAndExecuteHappyPathErasure('ac5')

      expect(res.statusCode).toBe(200)
      const body = res.json<{
        data: {
          requestId: string
          status: string
          completedAt: string
          revokedSessionCount: number
          auditEventId: string | null
        }
      }>()
      expect(body.data.status).toBe('completed')
      expect(body.data.revokedSessionCount).toBeGreaterThanOrEqual(1)
      expect(body.data.auditEventId).not.toBeNull()
    })

    async function assertUserAndIdentityErased(
      sam: { userId: string },
      beforeUser: { email: string; passwordHash: string } | undefined
    ) {
      const [afterUser] = await getDb()
        .select({
          email: users.email,
          passwordHash: users.passwordHash,
          mfaEnrolledAt: users.mfaEnrolledAt,
        })
        .from(users)
        .where(eq(users.id, sam.userId))
      expect(afterUser?.email).not.toBe(beforeUser?.email)
      expect(afterUser?.email).toMatch(/^erased_[0-9a-f]{12}@erased\.invalid$/)
      expect(afterUser?.passwordHash).not.toBe(beforeUser?.passwordHash)
      expect(afterUser?.mfaEnrolledAt).toBeNull()

      const identityRows = await getDb()
        .select({
          displayName: userIdentityTokens.displayName,
          pseudonymizedAt: userIdentityTokens.pseudonymizedAt,
        })
        .from(userIdentityTokens)
        .where(eq(userIdentityTokens.userId, sam.userId))
      expect(identityRows[0]?.pseudonymizedAt).not.toBeNull()
      expect(identityRows[0]?.displayName).toMatch(/^user_[a-z0-9]{8}$/)
    }

    it('purges every PII field/table field-by-field, not just the status code (AC-13)', async () => {
      const { owner, sam, requestId, beforeUser } = await seedAndExecuteHappyPathErasure('ac13')

      await assertUserAndIdentityErased(sam, beforeUser)

      const mfaEnrollmentRows = await getDb()
        .select()
        .from(mfaEnrollments)
        .where(eq(mfaEnrollments.userId, sam.userId))
      expect(mfaEnrollmentRows).toHaveLength(0)

      const recoveryCodeRows = await getDb()
        .select()
        .from(mfaRecoveryCodes)
        .where(eq(mfaRecoveryCodes.userId, sam.userId))
      expect(recoveryCodeRows).toHaveLength(0)

      const recoveryTokenRows = await getDb()
        .select()
        .from(accountRecoveryTokens)
        .where(eq(accountRecoveryTokens.userId, sam.userId))
      expect(recoveryTokenRows).toHaveLength(0)

      const sessionRows = await withOrg(owner.orgId, (tx) =>
        tx
          .select({
            ipAddress: sessions.ipAddress,
            userAgent: sessions.userAgent,
            revokedAt: sessions.revokedAt,
          })
          .from(sessions)
          .where(eq(sessions.userId, sam.userId))
      )
      expect(sessionRows.length).toBeGreaterThanOrEqual(1)
      assertEverySessionScrubbedAndRevoked(sessionRows)

      const requestRows = await withOrg(owner.orgId, (tx) =>
        tx.select().from(dataErasureRequests).where(eq(dataErasureRequests.id, requestId))
      )
      expect(requestRows[0]?.status).toBe('completed')
      expect(requestRows[0]?.completedAt).not.toBeNull()
    })

    it('requires confirm: true and mutates nothing otherwise (AC-6)', async () => {
      const owner = await registerOwner(app, 'ac6-owner')
      const sam = await addUserToOrg(app, owner.orgId, 'ac6-sam')
      const created = await createErasureRequest(app, owner.cookies, sam.userId)
      const requestId = created.json<{ data: { requestId: string } }>().data.requestId

      const missing = await executeErasureRequest(app, owner.cookies, sam.userId, requestId, {})
      expect(missing.statusCode).toBe(400)
      expect(missing.json()).toMatchObject({ code: 'confirmation_required' })

      const explicitFalse = await executeErasureRequest(app, owner.cookies, sam.userId, requestId, {
        confirm: false,
      })
      expect(explicitFalse.statusCode).toBe(400)
      expect(explicitFalse.json()).toMatchObject({ code: 'confirmation_required' })

      const rows = await withOrg(owner.orgId, (tx) =>
        tx.select().from(dataErasureRequests).where(eq(dataErasureRequests.id, requestId))
      )
      expect(rows[0]?.status).toBe('pending')
    })

    it('rejects a non-boolean confirm value and extra body fields at the schema layer (AC-6)', async () => {
      const owner = await registerOwner(app, 'ac6-schema-owner')
      const sam = await addUserToOrg(app, owner.orgId, 'ac6-schema-sam')
      const created = await createErasureRequest(app, owner.cookies, sam.userId)
      const requestId = created.json<{ data: { requestId: string } }>().data.requestId

      const stringConfirm = await executeErasureRequest(app, owner.cookies, sam.userId, requestId, {
        confirm: 'true',
      })
      expect(stringConfirm.statusCode).toBe(422)

      const numberConfirm = await executeErasureRequest(app, owner.cookies, sam.userId, requestId, {
        confirm: 1,
      })
      expect(numberConfirm.statusCode).toBe(422)

      const extraField = await executeErasureRequest(app, owner.cookies, sam.userId, requestId, {
        confirm: true,
        extra: 'nope',
      })
      expect(extraField.statusCode).toBe(422)
    })

    it('rejects an admin caller (403 insufficient_role, AC-7/D7)', async () => {
      const owner = await registerOwner(app, 'ac7-owner')
      const admin = await addUserToOrg(app, owner.orgId, 'ac7-admin', { orgRole: 'admin' })
      await enrollMfa(admin.userId)
      const sam = await addUserToOrg(app, owner.orgId, 'ac7-sam')
      const created = await createErasureRequest(app, owner.cookies, sam.userId)
      const requestId = created.json<{ data: { requestId: string } }>().data.requestId

      const res = await executeErasureRequest(app, admin.cookies, sam.userId, requestId)

      expect(res.statusCode).toBe(403)
      expect(res.json()).toMatchObject({ code: 'insufficient_role' })
    })

    it('returns 404 (not a leaked 403) for a requestId belonging to a different org (AC-19 tenant isolation)', async () => {
      const ownerA = await registerOwner(app, 'ac19-exec-owner-a')
      const ownerB = await registerOwner(app, 'ac19-exec-owner-b')
      const sam = await createSingleOrgMember(ownerA.orgId, 'ac19-exec-sam')
      const created = await createErasureRequest(app, ownerA.cookies, sam.userId)
      const requestId = created.json<{ data: { requestId: string } }>().data.requestId

      const res = await executeErasureRequest(app, ownerB.cookies, sam.userId, requestId)

      expect(res.statusCode).toBe(404)
      expect(res.json()).toMatchObject({ code: 'erasure_request_not_found' })
      const rows = await withOrg(ownerA.orgId, (tx) =>
        tx.select().from(dataErasureRequests).where(eq(dataErasureRequests.id, requestId))
      )
      expect(rows[0]?.status).toBe('pending')
    })

    it('blocks execution with a remediation path when the user has another org membership (AC-8, CRITICAL)', async () => {
      const ownerA = await registerOwner(app, 'ac8-owner-a')
      const ownerB = await registerOwner(app, 'ac8-owner-b')
      const sam = await createSingleOrgMember(ownerA.orgId, 'ac8-sam')
      await withOrg(ownerB.orgId, (tx) =>
        tx
          .insert(orgMemberships)
          .values({ orgId: ownerB.orgId, userId: sam.userId, role: 'member' })
      )
      const created = await createErasureRequest(app, ownerA.cookies, sam.userId)
      const requestId = created.json<{ data: { requestId: string } }>().data.requestId
      const [beforeUser] = await getDb()
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, sam.userId))

      const res = await executeErasureRequest(app, ownerA.cookies, sam.userId, requestId)

      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({
        code: 'user_has_other_org_memberships',
        otherOrgCount: 1,
        remediation: expect.stringContaining('Contact support'),
      })
      const [afterUser] = await getDb()
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, sam.userId))
      expect(afterUser?.email).toBe(beforeUser?.email)
      const rows = await withOrg(ownerA.orgId, (tx) =>
        tx.select().from(dataErasureRequests).where(eq(dataErasureRequests.id, requestId))
      )
      expect(rows[0]?.status).toBe('pending')
    })

    it('still blocks when the other org membership is deactivated, not active (AC-8 edge case)', async () => {
      const ownerA = await registerOwner(app, 'ac8b-owner-a')
      const ownerB = await registerOwner(app, 'ac8b-owner-b')
      const sam = await createSingleOrgMember(ownerA.orgId, 'ac8b-sam')
      await withOrg(ownerB.orgId, (tx) =>
        tx
          .insert(orgMemberships)
          .values({
            orgId: ownerB.orgId,
            userId: sam.userId,
            role: 'member',
            status: 'deactivated',
          })
      )
      const created = await createErasureRequest(app, ownerA.cookies, sam.userId)
      const requestId = created.json<{ data: { requestId: string } }>().data.requestId

      const res = await executeErasureRequest(app, ownerA.cookies, sam.userId, requestId)

      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ code: 'user_has_other_org_memberships', otherOrgCount: 1 })
    })

    it('succeeds on retry once the other org membership is removed (AC-8 positive confirmation)', async () => {
      const ownerA = await registerOwner(app, 'ac8c-owner-a')
      const ownerB = await registerOwner(app, 'ac8c-owner-b')
      const sam = await createSingleOrgMember(ownerA.orgId, 'ac8c-sam')
      await withOrg(ownerB.orgId, (tx) =>
        tx
          .insert(orgMemberships)
          .values({ orgId: ownerB.orgId, userId: sam.userId, role: 'member' })
      )
      const created = await createErasureRequest(app, ownerA.cookies, sam.userId)
      const requestId = created.json<{ data: { requestId: string } }>().data.requestId
      const blocked = await executeErasureRequest(app, ownerA.cookies, sam.userId, requestId)
      expect(blocked.statusCode).toBe(409)

      await withOrg(ownerB.orgId, (tx) =>
        tx
          .delete(orgMemberships)
          .where(and(eq(orgMemberships.orgId, ownerB.orgId), eq(orgMemberships.userId, sam.userId)))
      )

      const res = await executeErasureRequest(app, ownerA.cookies, sam.userId, requestId)

      expect(res.statusCode).toBe(200)
    })

    it('returns 409 already_completed on a second execute call with zero re-mutation (AC-9)', async () => {
      const owner = await registerOwner(app, 'ac9-owner')
      const sam = await createSingleOrgMember(owner.orgId, 'ac9-sam')
      const created = await createErasureRequest(app, owner.cookies, sam.userId)
      const requestId = created.json<{ data: { requestId: string } }>().data.requestId
      const first = await executeErasureRequest(app, owner.cookies, sam.userId, requestId)
      expect(first.statusCode).toBe(200)

      const second = await executeErasureRequest(app, owner.cookies, sam.userId, requestId)

      expect(second.statusCode).toBe(409)
      expect(second.json()).toMatchObject({ code: 'already_completed' })

      const auditRows = await withOrg(owner.orgId, (tx) =>
        tx
          .select()
          .from(auditLogEntries)
          .where(eq(auditLogEntries.eventType, AuditEvent.USER_ERASURE_EXECUTED))
      )
      expect(auditRows).toHaveLength(1)
    })

    it('resolves a concurrent double-execute race with exactly one winner (AC-10)', async () => {
      const owner = await registerOwner(app, 'ac10-owner')
      const sam = await createSingleOrgMember(owner.orgId, 'ac10-sam')
      const created = await createErasureRequest(app, owner.cookies, sam.userId)
      const requestId = created.json<{ data: { requestId: string } }>().data.requestId

      const [first, second] = await Promise.all([
        executeErasureRequest(app, owner.cookies, sam.userId, requestId),
        executeErasureRequest(app, owner.cookies, sam.userId, requestId),
      ])
      const statuses = [first.statusCode, second.statusCode].sort()
      expect(statuses).toEqual([200, 409])

      const auditRows = await withOrg(owner.orgId, (tx) =>
        tx
          .select()
          .from(auditLogEntries)
          .where(eq(auditLogEntries.eventType, AuditEvent.USER_ERASURE_EXECUTED))
      )
      expect(auditRows).toHaveLength(1)

      const sessionRows = await withOrg(owner.orgId, (tx) =>
        tx.select().from(sessions).where(eq(sessions.userId, sam.userId))
      )
      for (const row of sessionRows) expect(row.revokedAt).not.toBeNull()
    })

    it('preserves pre-existing audit rows and their HMAC verifiability across erasure (AC-11)', async () => {
      const owner = await registerOwner(app, 'ac11-owner')
      const sam = await createSingleOrgMember(owner.orgId, 'ac11-sam')

      // A pre-existing, genuinely HMAC-signed audit event referencing Sam's identity token (e.g.
      // from earlier activity) — written via the real production helper (writeHumanAuditEntry) so
      // GET /org/audit/verify's HMAC recomputation is a meaningful check, not a placeholder value.
      const before = await withOrg(owner.orgId, (tx) =>
        tx
          .select({ id: userIdentityTokens.id })
          .from(userIdentityTokens)
          .where(eq(userIdentityTokens.userId, sam.userId))
      )
      const samTokenId = before[0]?.id ?? null
      const { writeHumanAuditEntry } = await import('../audit/human-entry.js')
      await withOrg(owner.orgId, (tx) =>
        writeHumanAuditEntry(tx, {
          orgId: owner.orgId,
          actorTokenId: samTokenId,
          eventType: 'credential.value_revealed',
          payload: { note: 'pre-erasure event' },
        })
      )

      const created = await createErasureRequest(app, owner.cookies, sam.userId)
      const requestId = created.json<{ data: { requestId: string } }>().data.requestId
      const executed = await executeErasureRequest(app, owner.cookies, sam.userId, requestId)
      expect(executed.statusCode).toBe(200)

      const rowsAfter = await withOrg(owner.orgId, (tx) =>
        tx
          .select({ id: auditLogEntries.id, payload: auditLogEntries.payload })
          .from(auditLogEntries)
          .where(eq(auditLogEntries.eventType, 'credential.value_revealed'))
      )
      expect(rowsAfter).toHaveLength(1)
      expect(rowsAfter[0]?.payload).toMatchObject({ note: 'pre-erasure event' })

      const from = new Date(Date.now() - 3600_000).toISOString()
      const to = new Date(Date.now() + 3600_000).toISOString()
      const verifyRes = await app.inject({
        method: 'GET',
        url: `/api/v1/org/audit/verify?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
        headers: { cookie: cookieHeader(owner.cookies) },
      })
      expect(verifyRes.statusCode).toBe(200)
      expect(verifyRes.json()).toMatchObject({ data: { failed: [] } })
    })

    it('writes the erasure_executed audit event with the actor (not Sam) as actor and no PII in the payload (AC-12)', async () => {
      const owner = await registerOwner(app, 'ac12-owner')
      const sam = await createSingleOrgMember(owner.orgId, 'ac12-sam')
      const [samBefore] = await getDb()
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, sam.userId))
      const samEmail = samBefore?.email ?? ''

      const created = await createErasureRequest(app, owner.cookies, sam.userId)
      const requestId = created.json<{ data: { requestId: string } }>().data.requestId
      const executed = await executeErasureRequest(app, owner.cookies, sam.userId, requestId)
      expect(executed.statusCode).toBe(200)

      const [ownerTokenRow] = await withOrg(owner.orgId, (tx) =>
        tx
          .select({ id: userIdentityTokens.id })
          .from(userIdentityTokens)
          .where(eq(userIdentityTokens.userId, owner.userId))
      )
      const [auditRow] = await withOrg(owner.orgId, (tx) =>
        tx
          .select()
          .from(auditLogEntries)
          .where(eq(auditLogEntries.eventType, AuditEvent.USER_ERASURE_EXECUTED))
      )
      expect(auditRow?.actorTokenId).toBe(ownerTokenRow?.id)
      expect(auditRow?.resourceId).toBe(sam.userId)
      expect(auditRow?.resourceType).toBe('user')
      const payloadStr = JSON.stringify(auditRow?.payload)
      expect(payloadStr).not.toContain(samEmail)
      expect(payloadStr).not.toContain('displayName')
    })

    it('rolls back the entire transaction when the audit write fails (503 audit_write_failed)', async () => {
      const owner = await registerOwner(app, 'ac-audit-fail-owner')
      const sam = await createSingleOrgMember(owner.orgId, 'ac-audit-fail-sam')
      const created = await createErasureRequest(app, owner.cookies, sam.userId)
      const requestId = created.json<{ data: { requestId: string } }>().data.requestId
      const [beforeUser] = await getDb()
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, sam.userId))

      const humanAudit = await import('../audit/human-entry.js')
      const { vi } = await import('vitest')
      const auditSpy = vi
        .spyOn(humanAudit, 'writeHumanAuditEntry')
        .mockRejectedValueOnce(new Error('forced audit failure'))
      try {
        const res = await executeErasureRequest(app, owner.cookies, sam.userId, requestId)
        expectAuditWriteFailed(res)
      } finally {
        auditSpy.mockRestore()
      }

      const [afterUser] = await getDb()
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, sam.userId))
      expect(afterUser?.email).toBe(beforeUser?.email)
      const rows = await withOrg(owner.orgId, (tx) =>
        tx.select().from(dataErasureRequests).where(eq(dataErasureRequests.id, requestId))
      )
      expect(rows[0]?.status).toBe('pending')
    })
  })

  describe('GET /erasure-request/:requestId/report (AC-14 through AC-16)', () => {
    it('returns the compliance report shape after completion (AC-14)', async () => {
      const owner = await registerOwner(app, 'ac14-owner')
      const sam = await createSingleOrgMember(owner.orgId, 'ac14-sam')
      const created = await createErasureRequest(app, owner.cookies, sam.userId)
      const requestId = created.json<{ data: { requestId: string } }>().data.requestId
      const executed = await executeErasureRequest(app, owner.cookies, sam.userId, requestId)
      expect(executed.statusCode).toBe(200)

      const res = await getErasureReport(app, owner.cookies, sam.userId, requestId)

      expect(res.statusCode).toBe(200)
      const body = res.json<{
        data: {
          requestId: string
          executedAt: string
          piiRemoved: { table: string }[]
          piiRetained: { table: string }[]
          retentionJustification: string
          auditEventId: string | null
        }
      }>()
      expect(body.data.requestId).toBe(requestId)
      expect(body.data.piiRemoved.map((e) => e.table)).toEqual(
        expect.arrayContaining([
          'users',
          'user_identity_tokens',
          'mfa_enrollments',
          'mfa_recovery_codes',
          'account_recovery_tokens',
          'sessions',
        ])
      )
      expect(body.data.piiRetained.map((e) => e.table)).toEqual(
        expect.arrayContaining([
          'audit_log_entries',
          'org_memberships',
          'rotations.initiated_by',
          'project_invitations.invited_by',
        ])
      )
      expect(body.data.retentionJustification).toBe('audit log integrity')
      expect(body.data.auditEventId).not.toBeNull()
    })

    it('returns 404 for an unknown requestId (AC-15)', async () => {
      const owner = await registerOwner(app, 'ac15-owner')
      const sam = await addUserToOrg(app, owner.orgId, 'ac15-sam')

      const res = await getErasureReport(app, owner.cookies, sam.userId, randomUUID())

      expect(res.statusCode).toBe(404)
      expect(res.json()).toMatchObject({ code: 'erasure_request_not_found' })
    })

    it('returns 409 erasure_not_yet_completed while pending (AC-15)', async () => {
      const owner = await registerOwner(app, 'ac15-pending-owner')
      const sam = await addUserToOrg(app, owner.orgId, 'ac15-pending-sam')
      const created = await createErasureRequest(app, owner.cookies, sam.userId)
      const requestId = created.json<{ data: { requestId: string } }>().data.requestId

      const res = await getErasureReport(app, owner.cookies, sam.userId, requestId)

      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ code: 'erasure_not_yet_completed', status: 'pending' })
    })

    it('returns 404 for a requestId belonging to a different org (AC-15/AC-19 tenant isolation)', async () => {
      const ownerA = await registerOwner(app, 'ac19-owner-a')
      const ownerB = await registerOwner(app, 'ac19-owner-b')
      const sam = await addUserToOrg(app, ownerA.orgId, 'ac19-sam')
      const created = await createErasureRequest(app, ownerA.cookies, sam.userId)
      const requestId = created.json<{ data: { requestId: string } }>().data.requestId

      const res = await getErasureReport(app, ownerB.cookies, randomUUID(), requestId)

      expect(res.statusCode).toBe(404)
      expect(res.json()).toMatchObject({ code: 'erasure_request_not_found' })
    })

    it('rejects a member/viewer caller (403 insufficient_role, AC-16)', async () => {
      const owner = await registerOwner(app, 'ac16-owner')
      const member = await addUserToOrg(app, owner.orgId, 'ac16-member', { orgRole: 'member' })
      const sam = await addUserToOrg(app, owner.orgId, 'ac16-sam')
      const created = await createErasureRequest(app, owner.cookies, sam.userId)
      const requestId = created.json<{ data: { requestId: string } }>().data.requestId

      const res = await getErasureReport(app, member.cookies, sam.userId, requestId)

      expect(res.statusCode).toBe(403)
    })
  })
})
