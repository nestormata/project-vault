import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { withOrg } from '@project-vault/db'
import { auditLogEntries, organizations } from '@project-vault/db/schema'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  expectAuditWriteFailed,
  initVaultForTest,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { createMembershipTestHelpers } from '../../__tests__/helpers/membership-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'

const { createApp, initVault, humanAudit } = await bootstrapRouteIntegrationTest()
type TestApp = Awaited<ReturnType<typeof createApp>>

const EMAIL_PREFIX = 'org-default-locale-settings'
const ORG_NAME_PREFIX = 'Org Default Locale Settings'
const membershipHelpers = { emailPrefix: EMAIL_PREFIX, orgNamePrefix: ORG_NAME_PREFIX }
const { registerOwner, addUserToOrg } = createMembershipTestHelpers(membershipHelpers)

const PASSPHRASE = 'org-default-locale-settings-routes-passphrase'
const url = (orgId: string) => `/api/v1/organizations/${orgId}/default-locale-settings`

async function readDefaultLocale(orgId: string): Promise<string | undefined> {
  const [row] = await withOrg(orgId, (tx) =>
    tx.select().from(organizations).where(eq(organizations.id, orgId))
  )
  return row?.defaultLocale
}

describe('PATCH /api/v1/organizations/:orgId/default-locale-settings (Story 15.2 AC 1/5/6/7)', () => {
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

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('AC1: an admin-role user updates the org default locale to a supported value', async () => {
    const owner = await registerOwner(app, 'admin-update')
    const admin = await addUserToOrg(app, owner.orgId, 'admin-update-admin', { orgRole: 'admin' })

    const res = await app.inject({
      method: 'PATCH',
      url: url(owner.orgId),
      headers: { cookie: cookieHeader(admin.cookies) },
      payload: { defaultLocale: 'es' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ data: { orgId: owner.orgId, defaultLocale: 'es' } })
    expect(await readDefaultLocale(owner.orgId)).toBe('es')
  })

  it('AC1: an owner-role user succeeds identically to an admin', async () => {
    const owner = await registerOwner(app, 'owner-update')

    const res = await app.inject({
      method: 'PATCH',
      url: url(owner.orgId),
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { defaultLocale: 'es' },
    })

    expect(res.statusCode).toBe(200)
    expect(await readDefaultLocale(owner.orgId)).toBe('es')
  })

  it('AC1 edge: a member role is rejected with 403 and the column is unchanged', async () => {
    const owner = await registerOwner(app, 'member-forbidden')
    const member = await addUserToOrg(app, owner.orgId, 'member-forbidden-member', {
      orgRole: 'member',
    })

    const res = await app.inject({
      method: 'PATCH',
      url: url(owner.orgId),
      headers: { cookie: cookieHeader(member.cookies) },
      payload: { defaultLocale: 'es' },
    })

    expect(res.statusCode).toBe(403)
    expect(await readDefaultLocale(owner.orgId)).toBe('en')
  })

  it('AC1 edge: a viewer role is rejected with 403', async () => {
    const owner = await registerOwner(app, 'viewer-forbidden')
    const viewer = await addUserToOrg(app, owner.orgId, 'viewer-forbidden-viewer', {
      orgRole: 'viewer',
    })

    const res = await app.inject({
      method: 'PATCH',
      url: url(owner.orgId),
      headers: { cookie: cookieHeader(viewer.cookies) },
      payload: { defaultLocale: 'es' },
    })

    expect(res.statusCode).toBe(403)
  })

  it('AC1 edge: rejects an unsupported locale code with 422 before touching the DB', async () => {
    const owner = await registerOwner(app, 'invalid-locale')

    const res = await app.inject({
      method: 'PATCH',
      url: url(owner.orgId),
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { defaultLocale: 'xx' },
    })

    expect(res.statusCode).toBe(422)
    expect(await readDefaultLocale(owner.orgId)).toBe('en')
  })

  it('AC1 edge: rejects an empty-string locale with 422', async () => {
    const owner = await registerOwner(app, 'empty-locale')

    const res = await app.inject({
      method: 'PATCH',
      url: url(owner.orgId),
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { defaultLocale: '' },
    })

    expect(res.statusCode).toBe(422)
  })

  it('AC1 edge: .strict() rejects a body carrying an extra orgId field', async () => {
    const owner = await registerOwner(app, 'strict')

    const res = await app.inject({
      method: 'PATCH',
      url: url(owner.orgId),
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { defaultLocale: 'es', orgId: owner.orgId },
    })

    expect(res.statusCode).toBe(422)
  })

  it("AC1 edge: PATCHing a different org than the caller's own returns 404, not 403", async () => {
    const owner1 = await registerOwner(app, 'cross-org-caller')
    const owner2 = await registerOwner(app, 'cross-org-target')

    const res = await app.inject({
      method: 'PATCH',
      url: url(owner2.orgId),
      headers: { cookie: cookieHeader(owner1.cookies) },
      payload: { defaultLocale: 'es' },
    })

    expect(res.statusCode).toBe(404)
    expect(await readDefaultLocale(owner2.orgId)).toBe('en')
  })

  it('AC5: throttles far-more-than-normal repeated requests with 429', async () => {
    process.env['RATE_LIMIT_TEST_BYPASS'] = 'false'
    try {
      const owner = await registerOwner(app, 'rate-limit')
      const responses = []
      for (let i = 0; i < 11; i += 1) {
        responses.push(
          await app.inject({
            method: 'PATCH',
            url: url(owner.orgId),
            headers: { cookie: cookieHeader(owner.cookies) },
            payload: { defaultLocale: i % 2 === 0 ? 'es' : 'en' },
          })
        )
      }
      const lastResponse = responses.at(-1)
      expect(lastResponse?.statusCode).toBe(429)
    } finally {
      delete process.env['RATE_LIMIT_TEST_BYPASS']
    }
  }, 30_000)

  it('AC6: writes a human audit entry recording the previous and new default locale', async () => {
    const owner = await registerOwner(app, 'audit')

    const res = await app.inject({
      method: 'PATCH',
      url: url(owner.orgId),
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { defaultLocale: 'es' },
    })
    expect(res.statusCode).toBe(200)

    const [entry] = await withOrg(owner.orgId, (tx) =>
      tx
        .select()
        .from(auditLogEntries)
        .where(eq(auditLogEntries.eventType, 'organization.default_locale_updated'))
    )
    expect(entry).toBeDefined()
    expect(entry?.payload).toMatchObject({ previousDefaultLocale: 'en', newDefaultLocale: 'es' })
  })

  it('AC6 edge: rolls back the column change when the audit write fails', async () => {
    const owner = await registerOwner(app, 'audit-fail')
    const auditSpy = vi
      .spyOn(humanAudit, 'writeHumanAuditEntry')
      .mockRejectedValueOnce(new Error('forced audit failure'))

    try {
      const res = await app.inject({
        method: 'PATCH',
        url: url(owner.orgId),
        headers: { cookie: cookieHeader(owner.cookies) },
        payload: { defaultLocale: 'es' },
      })
      expectAuditWriteFailed(res)
      expect(await readDefaultLocale(owner.orgId)).toBe('en')
    } finally {
      auditSpy.mockRestore()
    }
  })

  it('AC7: an existing org (pre-dating this migration) already has the default en locale', async () => {
    const owner = await registerOwner(app, 'default-value')
    expect(await readDefaultLocale(owner.orgId)).toBe('en')
  })

  it('AC8: two sequential PATCHes from different admin sessions are last-write-wins', async () => {
    const owner = await registerOwner(app, 'concurrent')
    const admin = await addUserToOrg(app, owner.orgId, 'concurrent-admin', { orgRole: 'admin' })

    const first = await app.inject({
      method: 'PATCH',
      url: url(owner.orgId),
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { defaultLocale: 'es' },
    })
    const second = await app.inject({
      method: 'PATCH',
      url: url(owner.orgId),
      headers: { cookie: cookieHeader(admin.cookies) },
      payload: { defaultLocale: 'en' },
    })

    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(200)
    expect(await readDefaultLocale(owner.orgId)).toBe('en')
  })
})
