import { randomUUID } from 'node:crypto'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDb, withOrg } from '@project-vault/db'
import { organizations, orgSsoDomains } from '@project-vault/db/schema'
import {
  bootstrapRouteIntegrationTest,
  initVaultForTest,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { registerAuthStrategy, __resetAuthStrategiesForTests } from './strategies.js'

process.env['DATABASE_URL'] ??=
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'

let createApp: typeof import('../../app.js').createApp

const { initVault } = await bootstrapRouteIntegrationTest()

const PROVIDER = 'test.mock-sso-extension'
const DOMAIN_LOOKUP_URL = '/api/v1/auth/sso/domain-lookup'

async function createTestOrg(label: string) {
  const orgId = randomUUID()
  const suffix = orgId.slice(0, 8)
  await getDb()
    .insert(organizations)
    .values({
      id: orgId,
      name: `domain-lookup-${label}-${suffix}`,
      slug: `domain-lookup-${label}-${suffix}`,
    })
  return orgId
}

async function seedDomainMapping(orgId: string, domain: string, providerName: string) {
  await withOrg(orgId, (tx) => tx.insert(orgSsoDomains).values({ orgId, domain, providerName }))
}

describe('POST /api/v1/auth/sso/domain-lookup (Story 14.4)', () => {
  beforeAll(async () => {
    const { resetVaultForTest } = await import('../../__tests__/helpers/vault-test-cleanup.js')
    await resetVaultForTest()
    await initVaultForTest(initVault, 'domain-lookup-test-passphrase')
    createApp = (await import('../../app.js')).createApp
  })

  beforeEach(() => {
    __resetAuthStrategiesForTests()
  })

  it('AC-1: resolves ssoRequired + providerName for a domain mapped to a registered strategy', async () => {
    registerAuthStrategy(PROVIDER, {
      onAuthenticate: async () => ({ externalSubject: 'x', providerName: PROVIDER }),
    })
    const orgId = await createTestOrg('hit')
    const domain = `acme-${orgId.slice(0, 8)}.com`
    await seedDomainMapping(orgId, domain, PROVIDER)
    const app = await createApp({ logger: false })

    const res = await app.inject({
      method: 'POST',
      url: DOMAIN_LOOKUP_URL,
      payload: { email: `alex@${domain}` },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ssoRequired: true, providerName: PROVIDER })
    await app.close()
  })

  it('AC-1a: domain match is case-insensitive', async () => {
    registerAuthStrategy(PROVIDER, {
      onAuthenticate: async () => ({ externalSubject: 'x', providerName: PROVIDER }),
    })
    const orgId = await createTestOrg('case')
    const domain = `case-${orgId.slice(0, 8)}.com`
    await seedDomainMapping(orgId, domain, PROVIDER)
    const app = await createApp({ logger: false })

    const res = await app.inject({
      method: 'POST',
      url: DOMAIN_LOOKUP_URL,
      payload: { email: `Alex@${domain.toUpperCase()}` },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ssoRequired: true, providerName: PROVIDER })
    await app.close()
  })

  it('AC-1a: never matches a substring domain (notacme.com must NOT match acme.com)', async () => {
    registerAuthStrategy(PROVIDER, {
      onAuthenticate: async () => ({ externalSubject: 'x', providerName: PROVIDER }),
    })
    const orgId = await createTestOrg('substr')
    const domain = `acme-${orgId.slice(0, 8)}.com`
    await seedDomainMapping(orgId, domain, PROVIDER)
    const app = await createApp({ logger: false })

    const res = await app.inject({
      method: 'POST',
      url: DOMAIN_LOOKUP_URL,
      payload: { email: `alex@not${domain}` },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ssoRequired: false })
    await app.close()
  })

  it('AC-1c: subdomains do not match a parent-domain mapping', async () => {
    registerAuthStrategy(PROVIDER, {
      onAuthenticate: async () => ({ externalSubject: 'x', providerName: PROVIDER }),
    })
    const orgId = await createTestOrg('subdomain')
    const domain = `parent-${orgId.slice(0, 8)}.com`
    await seedDomainMapping(orgId, domain, PROVIDER)
    const app = await createApp({ logger: false })

    const res = await app.inject({
      method: 'POST',
      url: DOMAIN_LOOKUP_URL,
      payload: { email: `alex@mail.${domain}` },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ssoRequired: false })
    await app.close()
  })

  it('AC-1b: fails open when the mapped providerName is not currently registered', async () => {
    const orgId = await createTestOrg('unregistered')
    const domain = `unreg-${orgId.slice(0, 8)}.com`
    await seedDomainMapping(orgId, domain, 'some.unloaded.extension')
    const app = await createApp({ logger: false })

    const res = await app.inject({
      method: 'POST',
      url: DOMAIN_LOOKUP_URL,
      payload: { email: `alex@${domain}` },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ssoRequired: false })
    await app.close()
  })

  it('AC-2: returns ssoRequired:false for a domain with no mapping', async () => {
    const app = await createApp({ logger: false })
    const res = await app.inject({
      method: 'POST',
      url: DOMAIN_LOOKUP_URL,
      payload: { email: `nobody@no-mapping-${randomUUID()}.example` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ssoRequired: false })
    await app.close()
  })

  it('AC-2a: a malformed email (no @) is treated as "no mapping", not a 422/500', async () => {
    const app = await createApp({ logger: false })
    const res = await app.inject({
      method: 'POST',
      url: DOMAIN_LOOKUP_URL,
      payload: { email: 'not-an-email' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ssoRequired: false })
    await app.close()
  })

  it('AC-3/AC-3b: a DB error during lookup fails open to ssoRequired:false, never a 500', async () => {
    const dbModule = await import('../../lib/db.js')
    const spy = vi.spyOn(dbModule, 'getAdminDb').mockImplementationOnce(() => {
      throw new Error('simulated transient DB error')
    })
    const app = await createApp({ logger: false })

    const res = await app.inject({
      method: 'POST',
      url: DOMAIN_LOOKUP_URL,
      payload: { email: `alex@whatever-${randomUUID()}.example` },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ssoRequired: false })
    spy.mockRestore()
    await app.close()
  })

  it('AC-9a: response body never includes org id or name', async () => {
    registerAuthStrategy(PROVIDER, {
      onAuthenticate: async () => ({ externalSubject: 'x', providerName: PROVIDER }),
    })
    const orgId = await createTestOrg('shape')
    const domain = `shape-${orgId.slice(0, 8)}.com`
    await seedDomainMapping(orgId, domain, PROVIDER)
    const app = await createApp({ logger: false })

    const res = await app.inject({
      method: 'POST',
      url: DOMAIN_LOOKUP_URL,
      payload: { email: `alex@${domain}` },
    })

    const body = res.json() as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['providerName', 'ssoRequired'])
    expect(body['orgId']).toBeUndefined()
    expect(body['orgName']).toBeUndefined()
    await app.close()
  })

  it('rate-limits repeated calls beyond the configured max', async () => {
    // enforceUserRateLimit (route-helpers.ts) bypasses enforcement under NODE_ENV=test by
    // default (bootstrapRouteIntegrationTest sets RATE_LIMIT_TEST_BYPASS=true) — opt back in
    // here to cover real 429 behavior, mirroring secure-route.test.ts's own convention.
    process.env['RATE_LIMIT_TEST_BYPASS'] = 'false'
    const app = await createApp({ logger: false })
    try {
      let lastStatus = 200
      for (let i = 0; i < 25; i++) {
        const res = await app.inject({
          method: 'POST',
          url: DOMAIN_LOOKUP_URL,
          payload: { email: `probe-${i}@no-mapping.example` },
        })
        lastStatus = res.statusCode
      }
      expect(lastStatus).toBe(429)
    } finally {
      process.env['RATE_LIMIT_TEST_BYPASS'] = 'true'
      await app.close()
    }
  })

  it('rejects an oversized body (bodyLimit: 4096)', async () => {
    const app = await createApp({ logger: false })
    const res = await app.inject({
      method: 'POST',
      url: DOMAIN_LOOKUP_URL,
      payload: { email: `a@b.com`, padding: 'x'.repeat(5000) },
    })
    expect(res.statusCode).toBe(413)
    await app.close()
  })

  it('is registered as a public route in PUBLIC_ROUTE_EXEMPTIONS', async () => {
    const { PUBLIC_ROUTE_EXEMPTIONS } = await import('../../lib/route-exemptions.js')
    expect(
      PUBLIC_ROUTE_EXEMPTIONS.some((entry) => entry.route === `POST ${DOMAIN_LOOKUP_URL}`)
    ).toBe(true)
  })
})
