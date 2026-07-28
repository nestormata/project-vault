import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { getDb, withOrg } from '@project-vault/db'
import { externalIdentities, orgMemberships, users } from '@project-vault/db/schema'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { createDirectAuthenticatedUser } from '../../__tests__/helpers/org-role-test-helpers.js'

process.env['DATABASE_URL'] ??=
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'

let createApp: typeof import('../../app.js').createApp
const { initVault } = await bootstrapRouteIntegrationTest()

const ROUTE = '/api/v1/admin/external-identities'
const TEST_PROVIDER = 'com.acme.test-idp'
const EXPECTED_ROW_MESSAGE = 'expected target user row'
const UNENROLLED_ADMIN_LABEL = 'unenrolled-admin'

async function markMfaEnrolled(userId: string): Promise<void> {
  await getDb().update(users).set({ mfaEnrolledAt: new Date() }).where(eq(users.id, userId))
}

describe('POST /api/v1/admin/external-identities (Story 14.3 AC-10)', () => {
  beforeAll(async () => {
    const { resetVaultForTest } = await import('../../__tests__/helpers/vault-test-cleanup.js')
    await resetVaultForTest()
    const { initVaultForTest } = await import('../../__tests__/helpers/auth-test-helpers.js')
    await initVaultForTest(initVault, 'external-identity-routes-test-passphrase')
    createApp = (await import('../../app.js')).createApp
  })

  it('creates a new external_identities row and writes an EXTERNAL_IDENTITY_LINKED audit entry (happy path, 201)', async () => {
    const app = await createApp({ logger: false })
    const admin = await createDirectAuthenticatedUser(app, 'admin', 'admin', 'ext-identity')
    await markMfaEnrolled(admin.userId)

    const targetEmail = `linked-target-${randomUUID()}@example.com`
    const [target] = await getDb()
      .insert(users)
      .values({ email: targetEmail, passwordHash: 'x' })
      .returning({ id: users.id })
    if (!target) throw new Error(EXPECTED_ROW_MESSAGE)
    await withOrg(admin.orgId, (tx) =>
      tx
        .insert(orgMemberships)
        .values({ orgId: admin.orgId, userId: target.id, role: 'member', status: 'active' })
    )

    const res = await app.inject({
      method: 'POST',
      url: ROUTE,
      headers: { cookie: cookieHeader(admin.cookies) },
      payload: { userId: target.id, providerName: TEST_PROVIDER, externalSubject: 'sub-1' },
    })

    expect(res.statusCode).toBe(201)
    const body = res.json<{ data: { id: string; userId: string } }>()
    expect(body.data.userId).toBe(target.id)

    const [row] = await withOrg(admin.orgId, (tx) =>
      tx.select().from(externalIdentities).where(eq(externalIdentities.id, body.data.id))
    )
    expect(row).toBeDefined()

    await app.close()
  })

  it('rejects a duplicate (orgId, providerName, externalSubject) link with 409, not a silent overwrite', async () => {
    const app = await createApp({ logger: false })
    const admin = await createDirectAuthenticatedUser(app, 'admin', 'admin', 'ext-identity-dup')
    await markMfaEnrolled(admin.userId)

    const [target] = await getDb()
      .insert(users)
      .values({ email: `dup-target-${randomUUID()}@example.com`, passwordHash: 'x' })
      .returning({ id: users.id })
    if (!target) throw new Error(EXPECTED_ROW_MESSAGE)
    await withOrg(admin.orgId, (tx) =>
      tx
        .insert(orgMemberships)
        .values({ orgId: admin.orgId, userId: target.id, role: 'member', status: 'active' })
    )

    const payload = {
      userId: target.id,
      providerName: 'com.acme.dup-idp',
      externalSubject: 'dup-subject',
    }
    const first = await app.inject({
      method: 'POST',
      url: ROUTE,
      headers: { cookie: cookieHeader(admin.cookies) },
      payload,
    })
    expect(first.statusCode).toBe(201)

    const second = await app.inject({
      method: 'POST',
      url: ROUTE,
      headers: { cookie: cookieHeader(admin.cookies) },
      payload,
    })
    expect(second.statusCode).toBe(409)

    await app.close()
  })

  it("returns 403/404 for a userId that isn't a member of the caller's org", async () => {
    const app = await createApp({ logger: false })
    const admin = await createDirectAuthenticatedUser(
      app,
      'admin',
      'admin',
      'ext-identity-crossorg'
    )
    await markMfaEnrolled(admin.userId)

    const other = await createDirectAuthenticatedUser(
      app,
      'other-org-user',
      'member',
      'ext-identity-other'
    )

    const res = await app.inject({
      method: 'POST',
      url: ROUTE,
      headers: { cookie: cookieHeader(admin.cookies) },
      payload: { userId: other.userId, providerName: TEST_PROVIDER, externalSubject: 'cross-org' },
    })
    expect([403, 404]).toContain(res.statusCode)

    await app.close()
  })

  it.each(['member', 'viewer', 'owner'] as const)(
    'returns 403 for a non-admin caller (role: %s)',
    async (role) => {
      const app = await createApp({ logger: false })
      const caller = await createDirectAuthenticatedUser(
        app,
        `role-${role}`,
        role,
        'ext-identity-rbac'
      )
      await markMfaEnrolled(caller.userId)

      const [target] = await getDb()
        .insert(users)
        .values({ email: `rbac-target-${role}-${randomUUID()}@example.com`, passwordHash: 'x' })
        .returning({ id: users.id })
      if (!target) throw new Error(EXPECTED_ROW_MESSAGE)
      await withOrg(caller.orgId, (tx) =>
        tx
          .insert(orgMemberships)
          .values({ orgId: caller.orgId, userId: target.id, role: 'member', status: 'active' })
      )

      const res = await app.inject({
        method: 'POST',
        url: ROUTE,
        headers: { cookie: cookieHeader(caller.cookies) },
        payload: { userId: target.id, providerName: TEST_PROVIDER, externalSubject: 'rbac-test' },
      })
      expect(res.statusCode).toBe(403)

      await app.close()
    }
  )

  it('rejects an unenrolled admin (no MFA enrollment, no grace period) — requireMfa gate applies', async () => {
    const app = await createApp({ logger: false })
    const admin = await createDirectAuthenticatedUser(
      app,
      UNENROLLED_ADMIN_LABEL,
      'admin',
      'ext-identity-mfa'
    )
    // createDirectAuthenticatedUser grants no MFA grace period (unlike registerAndLoginViaApi),
    // and we deliberately do NOT call markMfaEnrolled here.
    const res = await app.inject({
      method: 'POST',
      url: ROUTE,
      headers: { cookie: cookieHeader(admin.cookies) },
      payload: { userId: admin.userId, providerName: TEST_PROVIDER, externalSubject: 'no-mfa' },
    })
    expect(res.statusCode).toBe(403)

    await app.close()
  })
})

/** Helper shared by the GET/DELETE describe blocks below: creates an admin + a linked target user. */
async function createAdminWithLinkedIdentity(
  app: Awaited<ReturnType<typeof createApp>>,
  emailPrefix: string
) {
  const admin = await createDirectAuthenticatedUser(app, 'admin', 'admin', emailPrefix)
  await markMfaEnrolled(admin.userId)

  const targetEmail = `${emailPrefix}-target-${randomUUID()}@example.com`
  const [target] = await getDb()
    .insert(users)
    .values({ email: targetEmail, passwordHash: 'x' })
    .returning({ id: users.id })
  if (!target) throw new Error(EXPECTED_ROW_MESSAGE)
  await withOrg(admin.orgId, (tx) =>
    tx
      .insert(orgMemberships)
      .values({ orgId: admin.orgId, userId: target.id, role: 'member', status: 'active' })
  )

  const providerName = TEST_PROVIDER
  const externalSubject = `sub-${randomUUID()}`
  const linkRes = await app.inject({
    method: 'POST',
    url: ROUTE,
    headers: { cookie: cookieHeader(admin.cookies) },
    payload: { userId: target.id, providerName, externalSubject },
  })
  const linked = linkRes.json<{ data: { id: string } }>()

  return {
    admin,
    target,
    targetEmail,
    providerName,
    externalSubject,
    identityId: linked.data.id,
  }
}

describe('GET /api/v1/admin/external-identities (Story 14.7 AC-1)', () => {
  beforeAll(async () => {
    createApp = (await import('../../app.js')).createApp
  })

  it('returns { data: [] } for an admin whose org has zero external_identities rows', async () => {
    const app = await createApp({ logger: false })
    const admin = await createDirectAuthenticatedUser(app, 'admin', 'admin', 'ext-list-empty')
    await markMfaEnrolled(admin.userId)

    const res = await app.inject({
      method: 'GET',
      url: ROUTE,
      headers: { cookie: cookieHeader(admin.cookies) },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json<{ data: unknown[] }>().data).toEqual([])

    await app.close()
  })

  it('returns joined rows (email, providerName, externalSubject, createdAt) for an org with linked identities', async () => {
    const app = await createApp({ logger: false })
    const { admin, target, targetEmail, providerName, externalSubject, identityId } =
      await createAdminWithLinkedIdentity(app, 'ext-list-rows')

    const res = await app.inject({
      method: 'GET',
      url: ROUTE,
      headers: { cookie: cookieHeader(admin.cookies) },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json<{
      data: Array<{
        id: string
        userId: string
        email: string
        providerName: string
        externalSubject: string
        createdAt: string
      }>
    }>()
    expect(body.data).toHaveLength(1)
    expect(body.data[0]).toMatchObject({
      id: identityId,
      userId: target.id,
      email: targetEmail,
      providerName,
      externalSubject,
    })
    expect(body.data[0]?.createdAt).toBeTruthy()

    await app.close()
  })

  it('AC-1 edge: cross-org isolation — org B admin never sees org A rows', async () => {
    const app = await createApp({ logger: false })
    await createAdminWithLinkedIdentity(app, 'ext-list-org-a')

    const orgBAdmin = await createDirectAuthenticatedUser(app, 'admin', 'admin', 'ext-list-org-b')
    await markMfaEnrolled(orgBAdmin.userId)

    const res = await app.inject({
      method: 'GET',
      url: ROUTE,
      headers: { cookie: cookieHeader(orgBAdmin.cookies) },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json<{ data: unknown[] }>().data).toEqual([])

    await app.close()
  })

  it.each(['member', 'viewer', 'owner'] as const)(
    'returns 403 for a non-admin caller (role: %s)',
    async (role) => {
      const app = await createApp({ logger: false })
      const caller = await createDirectAuthenticatedUser(app, `role-${role}`, role, 'ext-list-rbac')
      await markMfaEnrolled(caller.userId)

      const res = await app.inject({
        method: 'GET',
        url: ROUTE,
        headers: { cookie: cookieHeader(caller.cookies) },
      })
      expect(res.statusCode).toBe(403)

      await app.close()
    }
  )

  it('rejects an unenrolled admin (requireMfa applies to the read-only list too)', async () => {
    const app = await createApp({ logger: false })
    const admin = await createDirectAuthenticatedUser(
      app,
      UNENROLLED_ADMIN_LABEL,
      'admin',
      'ext-list-mfa'
    )

    const res = await app.inject({
      method: 'GET',
      url: ROUTE,
      headers: { cookie: cookieHeader(admin.cookies) },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json<{ code: string }>().code).toBe('mfa_required')

    await app.close()
  })
})

describe('DELETE /api/v1/admin/external-identities/:id (Story 14.7 AC-3)', () => {
  beforeAll(async () => {
    createApp = (await import('../../app.js')).createApp
  })

  it('happy path: hard-deletes the row (200) and it is gone from a follow-up GET', async () => {
    const app = await createApp({ logger: false })
    const { admin, identityId } = await createAdminWithLinkedIdentity(app, 'ext-del-happy')

    const res = await app.inject({
      method: 'DELETE',
      url: `${ROUTE}/${identityId}`,
      headers: { cookie: cookieHeader(admin.cookies) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ data: { id: string } }>()
    expect(body.data.id).toBe(identityId)

    const getRes = await app.inject({
      method: 'GET',
      url: ROUTE,
      headers: { cookie: cookieHeader(admin.cookies) },
    })
    expect(getRes.json<{ data: unknown[] }>().data).toEqual([])

    await app.close()
  })

  it('AC-3 edge: cross-org :id guess returns 404, row still present in the owning org', async () => {
    const app = await createApp({ logger: false })
    const { admin, identityId } = await createAdminWithLinkedIdentity(app, 'ext-del-org-a')

    const orgBAdmin = await createDirectAuthenticatedUser(app, 'admin', 'admin', 'ext-del-org-b')
    await markMfaEnrolled(orgBAdmin.userId)

    const res = await app.inject({
      method: 'DELETE',
      url: `${ROUTE}/${identityId}`,
      headers: { cookie: cookieHeader(orgBAdmin.cookies) },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json<{ code: string }>().code).toBe('not_found')

    // AC-3 edge (as written): "a follow-up GET from org A confirms the row is still present" —
    // must query using the *owning* org's context (org A's admin), not org B's. A query scoped to
    // org B would return zero rows regardless of whether org A's row still exists (RLS hides it
    // either way), so it can't prove anything about the row surviving the failed cross-org delete.
    const getRes = await app.inject({
      method: 'GET',
      url: ROUTE,
      headers: { cookie: cookieHeader(admin.cookies) },
    })
    expect(getRes.statusCode).toBe(200)
    const getBody = getRes.json<{ data: Array<{ id: string }> }>()
    expect(getBody.data.some((row) => row.id === identityId)).toBe(true)

    await app.close()
  })

  it('AC-3 edge: concurrent double-unlink — exactly one 200, one 404', async () => {
    const app = await createApp({ logger: false })
    const { admin, identityId } = await createAdminWithLinkedIdentity(app, 'ext-del-race')

    const [first, second] = await Promise.all([
      app.inject({
        method: 'DELETE',
        url: `${ROUTE}/${identityId}`,
        headers: { cookie: cookieHeader(admin.cookies) },
      }),
      app.inject({
        method: 'DELETE',
        url: `${ROUTE}/${identityId}`,
        headers: { cookie: cookieHeader(admin.cookies) },
      }),
    ])
    const statuses = [first.statusCode, second.statusCode].sort()
    expect(statuses).toEqual([200, 404])

    await app.close()
  })

  it.each(['member', 'viewer', 'owner'] as const)(
    'returns 403 for a non-admin caller (role: %s), before any row lookup',
    async (role) => {
      const app = await createApp({ logger: false })
      const caller = await createDirectAuthenticatedUser(app, `role-${role}`, role, 'ext-del-rbac')
      await markMfaEnrolled(caller.userId)

      const res = await app.inject({
        method: 'DELETE',
        url: `${ROUTE}/${randomUUID()}`,
        headers: { cookie: cookieHeader(caller.cookies) },
      })
      expect(res.statusCode).toBe(403)

      await app.close()
    }
  )

  it('rejects an unenrolled admin (requireMfa applies to delete)', async () => {
    const app = await createApp({ logger: false })
    const admin = await createDirectAuthenticatedUser(
      app,
      UNENROLLED_ADMIN_LABEL,
      'admin',
      'ext-del-mfa'
    )

    const res = await app.inject({
      method: 'DELETE',
      url: `${ROUTE}/${randomUUID()}`,
      headers: { cookie: cookieHeader(admin.cookies) },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json<{ code: string }>().code).toBe('mfa_required')

    await app.close()
  })

  it('writes an EXTERNAL_IDENTITY_UNLINKED audit entry with the expected payload shape', async () => {
    const app = await createApp({ logger: false })
    const { admin, target, providerName, externalSubject, identityId } =
      await createAdminWithLinkedIdentity(app, 'ext-del-audit')

    const res = await app.inject({
      method: 'DELETE',
      url: `${ROUTE}/${identityId}`,
      headers: { cookie: cookieHeader(admin.cookies) },
    })
    expect(res.statusCode).toBe(200)

    const { auditLogEntries } = await import('@project-vault/db/schema')
    // Both EXTERNAL_IDENTITY_LINKED (from createAdminWithLinkedIdentity's own POST) and this
    // test's EXTERNAL_IDENTITY_UNLINKED share the same resourceId — filter by eventType too
    // rather than relying on row order.
    const [entry] = await withOrg(admin.orgId, (tx) =>
      tx
        .select()
        .from(auditLogEntries)
        .where(
          and(
            eq(auditLogEntries.resourceId, identityId),
            eq(auditLogEntries.eventType, 'external_identity.unlinked')
          )
        )
    )
    expect(entry).toBeDefined()
    expect(entry?.eventType).toBe('external_identity.unlinked')
    expect(entry?.payload).toMatchObject({
      providerName,
      externalSubject,
      unlinkedUserId: target.id,
    })

    await app.close()
  })

  it("regression: unlinking a user's only external_identities row leaves their passwordHash-based login path intact", async () => {
    const app = await createApp({ logger: false })
    const { target, identityId, admin } = await createAdminWithLinkedIdentity(
      app,
      'ext-del-lockout'
    )

    const res = await app.inject({
      method: 'DELETE',
      url: `${ROUTE}/${identityId}`,
      headers: { cookie: cookieHeader(admin.cookies) },
    })
    expect(res.statusCode).toBe(200)

    const [row] = await getDb().select().from(users).where(eq(users.id, target.id))
    expect(row?.passwordHash).toBeTruthy()

    await app.close()
  })
})
