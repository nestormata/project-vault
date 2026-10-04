import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  configureAuthIntegrationEnv,
  cookieHeader,
  createProjectViaApi,
  initVaultForTest,
  registerAndLoginViaApi,
  type CookieJar,
} from './helpers/auth-test-helpers.js'
import { auditRowCount } from './helpers/api-routes-fixture.js'

/**
 * Story 68.10 — the module pack of `@project-vault/mock-ui-pack` through the REAL loader and
 * `createApp()` with a real database: the pack boots, its add / wrap / replace / HEAD routes answer
 * behind PV's own session, tenancy, capability and audit pipeline, the two `replaceSecurity`
 * declarations behave as declared, and the boot-fault switch makes a REQUIRED extension fail the
 * boot. It proves the pack is a valid M7 contribution before the composed Docker stack loads it.
 * Imported by string specifier only (never statically), like the other fixtures.
 */
const MOCK_PACK_PACKAGE = '@project-vault/mock-ui-pack'
process.env['VAULT_EXTENSIONS_PACKAGE'] = MOCK_PACK_PACKAGE
configureAuthIntegrationEnv()
// Rate-limit enforcement ON before any app boots (the per-route contexts register at boot).
process.env['RATE_LIMIT_TEST_BYPASS'] = 'false'

const { createApp } = await import('../app.js')
const { initVault } = await import('../modules/vault/key-service.js')
const { resetVaultForTest } = await import('./helpers/vault-test-cleanup.js')
const { __resetExtensionStateForTests } = await import('../extensions/loader.js')
const { __resetCapabilityGateForTests } = await import('../lib/capability-gate.js')
const { __resetAuthStrategiesForTests } = await import('../modules/auth/strategies.js')
const { ExtensionApiRouteBootError } = await import('../lib/secure-route-overrides.js')
const { createDirectAuthenticatedUser } = await import('./helpers/org-role-test-helpers.js')
const { env } = await import('../config/env.js')

type TestApp = Awaited<ReturnType<typeof createApp>>
type Owner = { userId: string; orgId: string; cookies: CookieJar }

const testLoginPassword = 'correct-horse-battery-staple'
const DOCUMENTS = '/api/v1/cm/documents'
const BOOT_FAULT_KEY = 'MOCK_UI_PACK_BOOT_FAULT'
const DOCUMENT_EVENT = 'cm.document.created'
const TILE_PREFIX = 'mock-ui-pack:m7-tile-'

const projectUrl = (projectId: string): string => `/api/v1/projects/${projectId}`
const as = (cookies: CookieJar): { cookie: string } => ({ cookie: cookieHeader(cookies) })

async function owner(app: TestApp, label: string): Promise<Owner> {
  return registerAndLoginViaApi(app, {
    email: `mock-ui-pack-${label}-${randomUUID()}@example.com`,
    password: testLoginPassword,
    orgName: `Mock UI Pack ${label} ${randomUUID().slice(0, 8)}`,
  })
}

function resetExtensionWorld(): void {
  __resetExtensionStateForTests()
  __resetCapabilityGateForTests()
  __resetAuthStrategiesForTests()
}

describe('Story 68.10 — the mock module pack through the real loader and createApp()', () => {
  let app: TestApp
  let orgA: Owner
  let orgB: Owner
  let projectA: string
  let projectB: string
  const saved = { required: env.VAULT_EXTENSIONS_REQUIRED }

  beforeAll(async () => {
    delete process.env['RELEASE_VERSION']
    await resetVaultForTest()
    await initVaultForTest(initVault, 'mock-ui-pack-integration-passphrase')
    resetExtensionWorld()
    app = await createApp({ logger: false, vaultGuardEnabled: true })
    orgA = await owner(app, 'a')
    orgB = await owner(app, 'b')
    projectA = await createProjectViaApi(app, orgA.cookies, 'mock-pack-a')
    projectB = await createProjectViaApi(app, orgB.cookies, 'mock-pack-b')
  }, 60_000)

  afterEach(() => {
    Object.assign(env, { VAULT_EXTENSIONS_REQUIRED: saved.required })
    vi.unstubAllEnvs()
  })

  afterAll(async () => {
    await app.close()
    resetExtensionWorld()
    await resetVaultForTest()
    process.env['RATE_LIMIT_TEST_BYPASS'] = 'true'
    delete process.env['VAULT_EXTENSIONS_PACKAGE']
  })

  it('loads the pack (health reports the extension loaded)', async () => {
    const health = await app.inject({ method: 'GET', url: '/health' })
    expect(health.json<{ extensions_status: string }>().extensions_status).toBe('loaded')
  })

  it('add: anonymous 401; a session reads only its own org rows through ctx.tx', async () => {
    expect((await app.inject({ method: 'GET', url: DOCUMENTS })).statusCode).toBe(401)
    const docs = await app.inject({ method: 'GET', url: DOCUMENTS, headers: as(orgA.cookies) })
    expect(docs.statusCode).toBe(200)
    const visible = docs.json<{ data: { orgId: string; visibleProjectIds: string[] } }>().data
    expect(visible.orgId).toBe(orgA.orgId)
    expect(visible.visibleProjectIds).toContain(projectA)
    expect(visible.visibleProjectIds).not.toContain(projectB)
  })

  it('wrap: adds the pack field and keeps PV fields; a cross-org read is PV 404; anonymous 401', async () => {
    const own = await app.inject({
      method: 'GET',
      url: projectUrl(projectA),
      headers: as(orgA.cookies),
    })
    expect(own.statusCode).toBe(200)
    const data = own.json<{ data: { id: string; name?: string; cmTiles: string[] } }>().data
    expect(data.id).toBe(projectA)
    expect(data.cmTiles).toEqual([`${TILE_PREFIX}${projectA}`])
    const cross = await app.inject({
      method: 'GET',
      url: projectUrl(projectA),
      headers: as(orgB.cookies),
    })
    expect(cross.statusCode).toBe(404)
    const missing = await app.inject({
      method: 'GET',
      url: projectUrl(randomUUID()),
      headers: as(orgB.cookies),
    })
    // no existence leak: another org's id and a nonexistent id answer identically
    expect(cross.body).toBe(missing.body)
    expect((await app.inject({ method: 'GET', url: projectUrl(projectA) })).statusCode).toBe(401)
  })

  it('HEAD: the explicit override sets its own header and sends no body', async () => {
    const head = await app.inject({
      method: 'HEAD',
      url: projectUrl(projectA),
      headers: as(orgA.cookies),
    })
    expect(head.statusCode).toBe(200)
    expect(head.headers['x-cm-head']).toBe('explicit')
    expect(head.body).toBe('')
  })

  it('replace: the pack body is served behind the session pipeline (anonymous 401)', async () => {
    const replaced = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      headers: as(orgA.cookies),
    })
    expect(replaced.statusCode).toBe(200)
    expect(replaced.json()).toEqual({ data: { cm: 'mock-ui-pack:m7-replaced' } })
    expect((await app.inject({ method: 'GET', url: '/api/v1/users/me' })).statusCode).toBe(401)
  })

  it('capability: the pack gate denies its write capability and permits the read one', async () => {
    const denied = await app.inject({
      method: 'GET',
      url: '/api/v1/cm/gated',
      headers: as(orgA.cookies),
    })
    expect(denied.statusCode).toBe(403)
    expect(denied.json()).toMatchObject({
      code: 'capability_denied',
      capability: 'cm.documents.write',
      reasonCode: 'mock_ui_pack_denied',
    })
    const allowed = await app.inject({
      method: 'GET',
      url: '/api/v1/cm/own-capability',
      headers: as(orgA.cookies),
    })
    expect(allowed.statusCode).toBe(200)
    expect(allowed.json()).toEqual({ data: 'mock-ui-pack:m7-capability-ok' })
  })

  it('public webhook outside /api/v1 answers without a session', async () => {
    const res = await app.inject({ method: 'POST', url: '/cm/webhooks/acme', payload: {} })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ received: 'acme' })
  })

  it('mutating add route: exactly one audit row of the pack event per call, none when denied', async () => {
    const before = await auditRowCount(orgA.orgId, DOCUMENT_EVENT)
    const denied = await app.inject({ method: 'POST', url: DOCUMENTS, payload: { title: 'x' } })
    expect(denied.statusCode).toBe(401)
    expect(await auditRowCount(orgA.orgId, DOCUMENT_EVENT)).toBe(before)
    const created = await app.inject({
      method: 'POST',
      url: DOCUMENTS,
      headers: as(orgA.cookies),
      payload: { title: 'Quarterly plan' },
    })
    expect(created.statusCode).toBe(200)
    expect(created.json()).toEqual({ data: { ok: true, title: 'Quarterly plan' } })
    expect(await auditRowCount(orgA.orgId, DOCUMENT_EVENT)).toBe(before + 1)
  })

  it('rate limit: the pack route has its own low bucket (429 on the 4th call); PV routes are unaffected', async () => {
    const limited = await owner(app, 'limited')
    const call = () =>
      app.inject({ method: 'GET', url: '/api/v1/cm/limited', headers: as(limited.cookies) })
    const statuses: number[] = []
    for (let index = 0; index < 4; index += 1) statuses.push((await call()).statusCode)
    expect(statuses).toEqual([200, 200, 200, 429])
    const docs = await app.inject({ method: 'GET', url: DOCUMENTS, headers: as(limited.cookies) })
    expect(docs.statusCode).toBe(200)
  })

  it('replaceSecurity: the loosened route is reachable anonymously, the tightened one needs an admin', async () => {
    const loosened = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/cli-login',
      payload: {},
    })
    expect(loosened.statusCode).toBe(200)
    expect(loosened.json()).toEqual({ cm: 'mock-ui-pack:m7-loosened' })
    const member = await createDirectAuthenticatedUser(app, 'mock-pack-member', 'member')
    const tightened = await app.inject({
      method: 'GET',
      url: '/api/v1/capabilities',
      headers: as(member.cookies),
    })
    expect(tightened.statusCode).toBe(403)
    expect(tightened.json()).toMatchObject({ code: 'insufficient_role' })
  })

  it('20 parallel requests from two orgs each see only their own rows (no cross-talk)', async () => {
    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, index) => {
        const caller = index % 2 === 0 ? orgA : orgB
        return app
          .inject({ method: 'GET', url: DOCUMENTS, headers: as(caller.cookies) })
          .then((res) => ({ caller, res }))
      })
    )
    for (const { caller, res } of responses) {
      const data = res.json<{ data: { orgId: string; visibleProjectIds: string[] } }>().data
      expect(data.orgId).toBe(caller.orgId)
      const other = caller === orgA ? projectB : projectA
      expect(data.visibleProjectIds).not.toContain(other)
    }
  })

  it('fail-closed boot: with the fault switch and VAULT_EXTENSIONS_REQUIRED the boot fails naming the missing target', async () => {
    vi.stubEnv(BOOT_FAULT_KEY, 'missing-target')
    Object.assign(env, { VAULT_EXTENSIONS_REQUIRED: true })
    resetExtensionWorld()
    let caught: unknown
    try {
      const faulty = await createApp({ logger: false, vaultGuardEnabled: true })
      await faulty.close()
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ExtensionApiRouteBootError)
    expect((caught as Error).message).toContain('GET /api/v1/mock-ui-pack-no-such-route')
    // with the fault off the same package boots again, so the failure was the fault
    vi.unstubAllEnvs()
    resetExtensionWorld()
    const healthy = await createApp({ logger: false, vaultGuardEnabled: true })
    const health = await healthy.inject({ method: 'GET', url: '/health' })
    expect(health.json<{ extensions_status: string }>().extensions_status).toBe('loaded')
    await healthy.close()
  })
})
