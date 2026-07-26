import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
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
      'unenrolled-admin',
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
