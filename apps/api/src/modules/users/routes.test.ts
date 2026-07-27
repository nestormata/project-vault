import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { withOrg } from '@project-vault/db'
import { auditLogEntries, users } from '@project-vault/db/schema'
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

const EMAIL_PREFIX = 'users-locale'
const ORG_NAME_PREFIX = 'Users Locale'
const membershipHelpers = { emailPrefix: EMAIL_PREFIX, orgNamePrefix: ORG_NAME_PREFIX }
const { registerOwner } = createMembershipTestHelpers(membershipHelpers)

const PASSPHRASE = 'users-locale-routes-passphrase'
const LOCALE_URL = '/api/v1/users/me/locale'

describe('PATCH /api/v1/users/me/locale (Story 15.1)', () => {
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

  it('AC7: GET /me defaults a brand-new user to locale en', async () => {
    const owner = await registerOwner(app, 'default')

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      headers: { cookie: cookieHeader(owner.cookies) },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ data: { locale: 'en' } })
  })

  it('AC2/AC6: changes locale from en to es and persists it on users.locale', async () => {
    const owner = await registerOwner(app, 'update')

    const res = await app.inject({
      method: 'PATCH',
      url: LOCALE_URL,
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { locale: 'es' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ data: { locale: 'es' } })

    const [row] = await withOrg(owner.orgId, (tx) =>
      tx.select().from(users).where(eq(users.id, owner.userId))
    )
    expect(row?.locale).toBe('es')
  })

  it('AC6 edge: rejects an unsupported locale code with 422 and leaves the stored value unchanged', async () => {
    const owner = await registerOwner(app, 'invalid')

    const res = await app.inject({
      method: 'PATCH',
      url: LOCALE_URL,
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { locale: 'xx' },
    })

    expect(res.statusCode).toBe(422)

    const [row] = await withOrg(owner.orgId, (tx) =>
      tx.select().from(users).where(eq(users.id, owner.userId))
    )
    expect(row?.locale).toBe('en')
  })

  it('AC6 edge: rejects a regional variant not in the compiled set (en-US) with 422', async () => {
    const owner = await registerOwner(app, 'invalid-regional')

    const res = await app.inject({
      method: 'PATCH',
      url: LOCALE_URL,
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { locale: 'en-US' },
    })

    expect(res.statusCode).toBe(422)
  })

  it('AC8: the .strict() schema rejects a body carrying an extra userId field', async () => {
    const owner = await registerOwner(app, 'strict')
    const { addUserToOrg } = createMembershipTestHelpers(membershipHelpers)
    const other = await addUserToOrg(app, owner.orgId, 'strict-victim')

    const res = await app.inject({
      method: 'PATCH',
      url: LOCALE_URL,
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { locale: 'es', userId: other.userId },
    })

    expect(res.statusCode).toBe(422)
  })

  it('AC8: two concurrently-authenticated users each only ever affect their own row', async () => {
    const owner = await registerOwner(app, 'cross-user')
    const { addUserToOrg } = createMembershipTestHelpers(membershipHelpers)
    const other = await addUserToOrg(app, owner.orgId, 'cross-user-victim')

    const ownerRes = await app.inject({
      method: 'PATCH',
      url: LOCALE_URL,
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { locale: 'es' },
    })
    expect(ownerRes.statusCode).toBe(200)

    const otherRes = await app.inject({
      method: 'PATCH',
      url: LOCALE_URL,
      headers: { cookie: cookieHeader(other.cookies) },
      payload: { locale: 'en' },
    })
    expect(otherRes.statusCode).toBe(200)

    const [ownerRow] = await withOrg(owner.orgId, (tx) =>
      tx.select().from(users).where(eq(users.id, owner.userId))
    )
    const [otherRow] = await withOrg(owner.orgId, (tx) =>
      tx.select().from(users).where(eq(users.id, other.userId))
    )
    expect(ownerRow?.locale).toBe('es')
    expect(otherRow?.locale).toBe('en')
  })

  it('AC9: writes a human audit entry with previous and new locale on a successful change', async () => {
    const owner = await registerOwner(app, 'audit')

    const res = await app.inject({
      method: 'PATCH',
      url: LOCALE_URL,
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { locale: 'es' },
    })
    expect(res.statusCode).toBe(200)

    const [entry] = await withOrg(owner.orgId, (tx) =>
      tx.select().from(auditLogEntries).where(eq(auditLogEntries.eventType, 'user.locale_updated'))
    )
    expect(entry).toBeDefined()
    expect(entry?.payload).toMatchObject({ previousLocale: 'en', newLocale: 'es' })
  })

  it('AC9 edge: rolls back the locale change when the audit write fails (503 audit_write_failed)', async () => {
    const owner = await registerOwner(app, 'audit-fail')
    const auditSpy = vi
      .spyOn(humanAudit, 'writeHumanAuditEntry')
      .mockRejectedValueOnce(new Error('forced audit failure'))

    try {
      const res = await app.inject({
        method: 'PATCH',
        url: LOCALE_URL,
        headers: { cookie: cookieHeader(owner.cookies) },
        payload: { locale: 'es' },
      })
      expectAuditWriteFailed(res)

      const [row] = await withOrg(owner.orgId, (tx) =>
        tx.select().from(users).where(eq(users.id, owner.userId))
      )
      expect(row?.locale).toBe('en')
    } finally {
      auditSpy.mockRestore()
    }
  })

  it('AC10: throttles far-more-than-normal repeated locale-change requests with 429', async () => {
    process.env['RATE_LIMIT_TEST_BYPASS'] = 'false'
    try {
      const owner = await registerOwner(app, 'rate-limit')
      const responses = []
      for (let i = 0; i < 11; i += 1) {
        responses.push(
          await app.inject({
            method: 'PATCH',
            url: LOCALE_URL,
            headers: { cookie: cookieHeader(owner.cookies) },
            payload: { locale: i % 2 === 0 ? 'es' : 'en' },
          })
        )
      }
      const lastResponse = responses.at(-1)
      expect(lastResponse?.statusCode).toBe(429)
    } finally {
      delete process.env['RATE_LIMIT_TEST_BYPASS']
    }
  }, 30_000)
})
