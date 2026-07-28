import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { auditLogEntries, orgSsoDomains } from '@project-vault/db/schema'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  expectAuditWriteFailed,
  initVaultForTest,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { createMembershipTestHelpers } from '../../__tests__/helpers/membership-test-helpers.js'
import { createDirectAuthenticatedUser } from '../../__tests__/helpers/org-role-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import { __resetAuthStrategiesForTests, registerAuthStrategy } from './strategies.js'
import { ssoErrorMessage } from './org-sso-domains-routes.js'
import { runDomainWrite } from './org-sso-domains-service.js'

const { createApp, initVault, humanAudit } = await bootstrapRouteIntegrationTest()
type TestApp = Awaited<ReturnType<typeof createApp>>

const EMAIL_PREFIX = 'org-sso-domains'
const ORG_NAME_PREFIX = 'Org SSO Domains'
const { registerOwner, addUserToOrg } = createMembershipTestHelpers({
  emailPrefix: EMAIL_PREFIX,
  orgNamePrefix: ORG_NAME_PREFIX,
})

const PASSPHRASE = 'org-sso-domains-routes-passphrase'
const PROVIDER = 'test.mock-sso-extension'
const LIST_URL = '/api/v1/org/sso-domains'
const itemUrl = (id: string) => `/api/v1/org/sso-domains/${id}`

function uniqueDomain(label: string): string {
  return `${label}-${randomUUID().slice(0, 8)}.example`
}

function mustRow<T>(row: T | undefined): T {
  if (!row) throw new Error('expected a row to be returned')
  return row
}

async function readRows(orgId: string) {
  return withOrg(orgId, (tx) => tx.select().from(orgSsoDomains))
}

describe('org-sso-domains-routes (Story 14.6)', () => {
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

  beforeEach(() => {
    __resetAuthStrategiesForTests()
    registerAuthStrategy(PROVIDER, {
      onAuthenticate: async () => ({ externalSubject: 'x', providerName: PROVIDER }),
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ---------------------------------------------------------------------------------------------
  // AC-1: list
  // ---------------------------------------------------------------------------------------------

  it('AC-1: an admin lists their org SSO domain mappings', async () => {
    const owner = await registerOwner(app, 'list-admin')
    const admin = await addUserToOrg(app, owner.orgId, 'list-admin-admin', { orgRole: 'admin' })
    await withOrg(owner.orgId, (tx) =>
      tx.insert(orgSsoDomains).values({
        orgId: owner.orgId,
        domain: uniqueDomain('list'),
        providerName: PROVIDER,
      })
    )

    const res = await app.inject({
      method: 'GET',
      url: LIST_URL,
      headers: { cookie: cookieHeader(admin.cookies) },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json<{ domain: string; providerName: string; id: string }[]>()
    expect(body).toHaveLength(1)
    expect(body[0]).toMatchObject({ providerName: PROVIDER })
  })

  it('AC-1: an honest empty array for an org with zero mappings', async () => {
    const owner = await registerOwner(app, 'list-empty')
    const res = await app.inject({
      method: 'GET',
      url: LIST_URL,
      headers: { cookie: cookieHeader(owner.cookies) },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
  })

  it('AC-1 edge case: cross-org isolation — org B never sees org A rows via the write-path routes', async () => {
    const ownerA = await registerOwner(app, 'iso-a')
    const ownerB = await registerOwner(app, 'iso-b')
    await withOrg(ownerA.orgId, (tx) =>
      tx.insert(orgSsoDomains).values({
        orgId: ownerA.orgId,
        domain: uniqueDomain('iso-a'),
        providerName: PROVIDER,
      })
    )

    const res = await app.inject({
      method: 'GET',
      url: LIST_URL,
      headers: { cookie: cookieHeader(ownerB.cookies) },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
  })

  // ---------------------------------------------------------------------------------------------
  // AC-5: RBAC (list + create)
  // ---------------------------------------------------------------------------------------------

  it('AC-5: owner is allowed to list (minimumRole admin includes owner)', async () => {
    const owner = await registerOwner(app, 'rbac-owner-list')
    const res = await app.inject({
      method: 'GET',
      url: LIST_URL,
      headers: { cookie: cookieHeader(owner.cookies) },
    })
    expect(res.statusCode).toBe(200)
  })

  it('AC-5: a member role is rejected with 403 on list', async () => {
    const owner = await registerOwner(app, 'rbac-member-list')
    const member = await addUserToOrg(app, owner.orgId, 'rbac-member-list-m', { orgRole: 'member' })
    const res = await app.inject({
      method: 'GET',
      url: LIST_URL,
      headers: { cookie: cookieHeader(member.cookies) },
    })
    expect(res.statusCode).toBe(403)
  })

  it('AC-5: a viewer role is rejected with 403 on list', async () => {
    const owner = await registerOwner(app, 'rbac-viewer-list')
    const viewer = await addUserToOrg(app, owner.orgId, 'rbac-viewer-list-v', { orgRole: 'viewer' })
    const res = await app.inject({
      method: 'GET',
      url: LIST_URL,
      headers: { cookie: cookieHeader(viewer.cookies) },
    })
    expect(res.statusCode).toBe(403)
  })

  it('AC-5: a member role is rejected with 403 on create, and no row is written', async () => {
    const owner = await registerOwner(app, 'rbac-member-create')
    const member = await addUserToOrg(app, owner.orgId, 'rbac-member-create-m', {
      orgRole: 'member',
    })
    const domain = uniqueDomain('rbac-member')
    const res = await app.inject({
      method: 'POST',
      url: LIST_URL,
      headers: { cookie: cookieHeader(member.cookies) },
      payload: { domain, providerName: PROVIDER },
    })
    expect(res.statusCode).toBe(403)
    expect(await readRows(owner.orgId)).toHaveLength(0)
  })

  // ---------------------------------------------------------------------------------------------
  // AC-6: auth / MFA
  // ---------------------------------------------------------------------------------------------

  it('AC-6: an unauthenticated request to list is rejected with 401', async () => {
    const res = await app.inject({ method: 'GET', url: LIST_URL })
    expect(res.statusCode).toBe(401)
  })

  it('AC-6: an admin who has not enrolled in MFA gets 403 mfa_required on list', async () => {
    const unenrolledAdmin = await createDirectAuthenticatedUser(
      app,
      'mfa-list',
      'admin',
      'sso-domains-mfa'
    )
    const res = await app.inject({
      method: 'GET',
      url: LIST_URL,
      headers: { cookie: cookieHeader(unenrolledAdmin.cookies) },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ code: 'mfa_required' })
  })

  it('AC-6: an admin who has not enrolled in MFA gets 403 mfa_required on create', async () => {
    const unenrolledAdmin = await createDirectAuthenticatedUser(
      app,
      'mfa-create',
      'admin',
      'sso-domains-mfa'
    )
    const res = await app.inject({
      method: 'POST',
      url: LIST_URL,
      headers: { cookie: cookieHeader(unenrolledAdmin.cookies) },
      payload: { domain: uniqueDomain('mfa'), providerName: PROVIDER },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ code: 'mfa_required' })
  })

  // ---------------------------------------------------------------------------------------------
  // AC-2: create
  // ---------------------------------------------------------------------------------------------

  it('AC-2: creates a mapping, normalizing an uppercase domain with a trailing FQDN dot', async () => {
    const owner = await registerOwner(app, 'create-normalize')
    const raw = uniqueDomain('Create-Norm').toUpperCase() + '.'

    const res = await app.inject({
      method: 'POST',
      url: LIST_URL,
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { domain: raw, providerName: PROVIDER },
    })

    expect(res.statusCode).toBe(201)
    const body = res.json<{ domain: string; id: string }>()
    expect(body.domain).toBe(raw.toLowerCase().slice(0, -1))
    const rows = await readRows(owner.orgId)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.domain).toBe(raw.toLowerCase().slice(0, -1))
  })

  it('AC-2(b): rejects a malformed domain with 422 invalid_domain_format', async () => {
    const owner = await registerOwner(app, 'create-invalid')
    const res = await app.inject({
      method: 'POST',
      url: LIST_URL,
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { domain: 'not a domain @', providerName: PROVIDER },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({ code: 'invalid_domain_format' })
  })

  it('AC-2(c): rejects a public-email domain with 422 public_domain_blocked, even with a trailing dot', async () => {
    const owner = await registerOwner(app, 'create-public')
    const res = await app.inject({
      method: 'POST',
      url: LIST_URL,
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { domain: 'gmail.com.', providerName: PROVIDER },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({ code: 'public_domain_blocked' })
    expect(await readRows(owner.orgId)).toHaveLength(0)
  })

  it('AC-2(d): rejects a providerName that is not registered with 422 provider_not_registered', async () => {
    const owner = await registerOwner(app, 'create-unregistered')
    const res = await app.inject({
      method: 'POST',
      url: LIST_URL,
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { domain: uniqueDomain('unreg'), providerName: 'not.a.real.provider' },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({ code: 'provider_not_registered' })
  })

  it('AC-2(e): a throwing findAuthStrategy() maps to 503 provider_check_unavailable, not 422/500', async () => {
    const owner = await registerOwner(app, 'create-unavailable')
    const strategiesModule = await import('./strategies.js')
    const spy = vi.spyOn(strategiesModule, 'findAuthStrategy').mockImplementationOnce(() => {
      throw new Error('extension runtime crashed')
    })
    try {
      const res = await app.inject({
        method: 'POST',
        url: LIST_URL,
        headers: { cookie: cookieHeader(owner.cookies) },
        payload: { domain: uniqueDomain('unavail'), providerName: PROVIDER },
      })
      expect(res.statusCode).toBe(503)
      expect(res.json()).toMatchObject({ code: 'provider_check_unavailable' })
    } finally {
      spy.mockRestore()
    }
  })

  it('AC-2 edge case: a globally-claimed domain (different org) returns 409 with no org disclosure', async () => {
    const ownerA = await registerOwner(app, 'conflict-a')
    const ownerB = await registerOwner(app, 'conflict-b')
    const domain = uniqueDomain('conflict')
    await withOrg(ownerA.orgId, (tx) =>
      tx.insert(orgSsoDomains).values({ orgId: ownerA.orgId, domain, providerName: PROVIDER })
    )

    const res = await app.inject({
      method: 'POST',
      url: LIST_URL,
      headers: { cookie: cookieHeader(ownerB.cookies) },
      payload: { domain, providerName: PROVIDER },
    })

    expect(res.statusCode).toBe(409)
    const body = res.json<{ code: string; message: string }>()
    expect(body.code).toBe('domain_already_mapped')
    expect(body.message.toLowerCase()).not.toContain(ownerA.orgId.toLowerCase())
    expect(JSON.stringify(body)).not.toContain(ownerA.orgId)
  })

  it('AC-8: two concurrent creates for the same domain resolve to exactly one success and a 409, never a 500', async () => {
    const ownerA = await registerOwner(app, 'race-a')
    const ownerB = await registerOwner(app, 'race-b')
    const domain = uniqueDomain('race')

    const [resA, resB] = await Promise.all([
      app.inject({
        method: 'POST',
        url: LIST_URL,
        headers: { cookie: cookieHeader(ownerA.cookies) },
        payload: { domain, providerName: PROVIDER },
      }),
      app.inject({
        method: 'POST',
        url: LIST_URL,
        headers: { cookie: cookieHeader(ownerB.cookies) },
        payload: { domain, providerName: PROVIDER },
      }),
    ])

    expect([resA.statusCode, resB.statusCode].sort()).toEqual([201, 409])
    const totalRows = (await readRows(ownerA.orgId)).length + (await readRows(ownerB.orgId)).length
    expect(totalRows).toBe(1)
  })

  // ---------------------------------------------------------------------------------------------
  // AC-3: update
  // ---------------------------------------------------------------------------------------------

  it('AC-3: an admin edits an existing row and receives the updated row', async () => {
    const owner = await registerOwner(app, 'update-basic')
    const [row] = await withOrg(owner.orgId, (tx) =>
      tx
        .insert(orgSsoDomains)
        .values({ orgId: owner.orgId, domain: uniqueDomain('upd'), providerName: PROVIDER })
        .returning()
    )
    const newDomain = uniqueDomain('upd-new')

    const res = await app.inject({
      method: 'PATCH',
      url: itemUrl(mustRow(row).id),
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { domain: newDomain },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      id: mustRow(row).id,
      domain: newDomain,
      providerName: PROVIDER,
    })
  })

  it("AC-3 edge case: a cross-org :id guess returns 404, not 403 (doesn't confirm existence)", async () => {
    const ownerA = await registerOwner(app, 'update-cross-a')
    const ownerB = await registerOwner(app, 'update-cross-b')
    const [row] = await withOrg(ownerA.orgId, (tx) =>
      tx
        .insert(orgSsoDomains)
        .values({ orgId: ownerA.orgId, domain: uniqueDomain('cross'), providerName: PROVIDER })
        .returning()
    )

    const res = await app.inject({
      method: 'PATCH',
      url: itemUrl(mustRow(row).id),
      headers: { cookie: cookieHeader(ownerB.cookies) },
      payload: { domain: uniqueDomain('cross-attempt') },
    })

    expect(res.statusCode).toBe(404)
  })

  it('AC-3 edge case: editing a domain to one already claimed by a different row returns 409 domain_already_mapped', async () => {
    const owner = await registerOwner(app, 'update-conflict')
    const takenDomain = uniqueDomain('taken')
    await withOrg(owner.orgId, (tx) =>
      tx
        .insert(orgSsoDomains)
        .values({ orgId: owner.orgId, domain: takenDomain, providerName: PROVIDER })
    )
    const [row] = await withOrg(owner.orgId, (tx) =>
      tx
        .insert(orgSsoDomains)
        .values({ orgId: owner.orgId, domain: uniqueDomain('other'), providerName: PROVIDER })
        .returning()
    )

    const res = await app.inject({
      method: 'PATCH',
      url: itemUrl(mustRow(row).id),
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { domain: takenDomain },
    })

    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'domain_already_mapped' })
  })

  it('AC-3: update applies the same public-domain blocklist check as create', async () => {
    const owner = await registerOwner(app, 'update-public')
    const [row] = await withOrg(owner.orgId, (tx) =>
      tx
        .insert(orgSsoDomains)
        .values({ orgId: owner.orgId, domain: uniqueDomain('pub'), providerName: PROVIDER })
        .returning()
    )

    const res = await app.inject({
      method: 'PATCH',
      url: itemUrl(mustRow(row).id),
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { domain: 'outlook.com' },
    })

    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({ code: 'public_domain_blocked' })
  })

  // ---------------------------------------------------------------------------------------------
  // AC-4: delete
  // ---------------------------------------------------------------------------------------------

  it('AC-4: an admin hard-deletes an existing row and gets { id } back', async () => {
    const owner = await registerOwner(app, 'delete-basic')
    const [row] = await withOrg(owner.orgId, (tx) =>
      tx
        .insert(orgSsoDomains)
        .values({ orgId: owner.orgId, domain: uniqueDomain('del'), providerName: PROVIDER })
        .returning()
    )

    const res = await app.inject({
      method: 'DELETE',
      url: itemUrl(mustRow(row).id),
      headers: { cookie: cookieHeader(owner.cookies) },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ id: mustRow(row).id })
    expect(await readRows(owner.orgId)).toHaveLength(0)
  })

  it('AC-4: a cross-org :id guess on delete returns 404', async () => {
    const ownerA = await registerOwner(app, 'delete-cross-a')
    const ownerB = await registerOwner(app, 'delete-cross-b')
    const [row] = await withOrg(ownerA.orgId, (tx) =>
      tx
        .insert(orgSsoDomains)
        .values({ orgId: ownerA.orgId, domain: uniqueDomain('del-cross'), providerName: PROVIDER })
        .returning()
    )

    const res = await app.inject({
      method: 'DELETE',
      url: itemUrl(mustRow(row).id),
      headers: { cookie: cookieHeader(ownerB.cookies) },
    })

    expect(res.statusCode).toBe(404)
    expect(await readRows(ownerA.orgId)).toHaveLength(1)
  })

  // ---------------------------------------------------------------------------------------------
  // AC-7: audit
  // ---------------------------------------------------------------------------------------------

  it('AC-7: create writes an org_sso_domain.created audit row in the same transaction', async () => {
    const owner = await registerOwner(app, 'audit-create')
    const domain = uniqueDomain('audit-create')

    const res = await app.inject({
      method: 'POST',
      url: LIST_URL,
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { domain, providerName: PROVIDER },
    })
    expect(res.statusCode).toBe(201)
    const created = res.json<{ id: string }>()

    const [entry] = await withOrg(owner.orgId, (tx) =>
      tx
        .select()
        .from(auditLogEntries)
        .where(eq(auditLogEntries.eventType, 'org_sso_domain.created'))
    )
    expect(entry).toBeDefined()
    expect(entry?.payload).toMatchObject({ id: created.id, domain, providerName: PROVIDER })
  })

  it('AC-7 fail-closed: rolls back the create when the audit write fails (503 audit_write_failed)', async () => {
    const owner = await registerOwner(app, 'audit-fail-create')
    const auditSpy = vi
      .spyOn(humanAudit, 'writeHumanAuditEntry')
      .mockRejectedValueOnce(new Error('forced audit failure'))
    try {
      const res = await app.inject({
        method: 'POST',
        url: LIST_URL,
        headers: { cookie: cookieHeader(owner.cookies) },
        payload: { domain: uniqueDomain('audit-fail'), providerName: PROVIDER },
      })
      expectAuditWriteFailed(res)
      expect(await readRows(owner.orgId)).toHaveLength(0)
    } finally {
      auditSpy.mockRestore()
    }
  })

  it('AC-7: the list route writes no audit event', async () => {
    const owner = await registerOwner(app, 'audit-list')
    const before = await withOrg(owner.orgId, (tx) => tx.select().from(auditLogEntries))

    const res = await app.inject({
      method: 'GET',
      url: LIST_URL,
      headers: { cookie: cookieHeader(owner.cookies) },
    })
    expect(res.statusCode).toBe(200)

    const after = await withOrg(owner.orgId, (tx) => tx.select().from(auditLogEntries))
    expect(after).toHaveLength(before.length)
  })

  // ---------------------------------------------------------------------------------------------
  // AC-9: rate limiting
  // ---------------------------------------------------------------------------------------------

  it('AC-9: throttles far-more-than-normal repeated create requests with 429', async () => {
    process.env['RATE_LIMIT_TEST_BYPASS'] = 'false'
    try {
      const owner = await registerOwner(app, 'rate-limit-create')
      let lastStatus = 0
      for (let i = 0; i < 21; i += 1) {
        const res = await app.inject({
          method: 'POST',
          url: LIST_URL,
          headers: { cookie: cookieHeader(owner.cookies) },
          payload: { domain: uniqueDomain(`rl-${i}`), providerName: PROVIDER },
        })
        lastStatus = res.statusCode
      }
      expect(lastStatus).toBe(429)
    } finally {
      delete process.env['RATE_LIMIT_TEST_BYPASS']
    }
  }, 30_000)
})

describe('ssoErrorMessage', () => {
  it('maps every known error code to its specific message, including the two branches unreachable via the live route flow', () => {
    // invalid_domain_format never reaches the handler in practice (the schema layer's .refine()
    // already rejects a malformed domain before the route runs) — pinned directly here instead.
    expect(ssoErrorMessage('invalid_domain_format')).toBe('Domain is not a valid hostname')
    expect(ssoErrorMessage('public_domain_blocked')).toMatch(/shared public email providers/)
    expect(ssoErrorMessage('provider_not_registered')).toBe(
      'This provider is not currently registered'
    )
    expect(ssoErrorMessage('provider_check_unavailable')).toMatch(/try again shortly/)
    expect(ssoErrorMessage('domain_already_mapped')).toBe(
      'This domain is already mapped to an organization'
    )
    // The default fallback is likewise unreachable given result.code's closed union type — still
    // worth proving it degrades to a safe generic message rather than throwing.
    expect(ssoErrorMessage('some_future_unmapped_code')).toBe('Request failed')
  })
})

describe('runDomainWrite', () => {
  it('rethrows a non-unique-violation error instead of swallowing it as a 409', async () => {
    const boom = new Error('connection reset')
    await expect(runDomainWrite(() => Promise.reject(boom))).rejects.toThrow('connection reset')
  })
})
