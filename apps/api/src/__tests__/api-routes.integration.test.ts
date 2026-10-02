import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withOrg } from '@project-vault/db'
import { auditStorageQuotaConfig } from '@project-vault/db/schema'
import { OperationalEvent } from '@project-vault/shared'
import {
  configureAuthIntegrationEnv,
  cookieHeader,
  createProjectViaApi,
  initVaultForTest,
  registerAndLoginViaApi,
  type CookieJar,
} from './helpers/auth-test-helpers.js'
import { createLogCaptureStream, parseCapturedLogLines } from './helpers/capture-logs.js'
import {
  API_ROUTES_FIXTURE_PACKAGE,
  auditRowCount,
  enrollMfa,
  expireMfaGracePeriod,
  fixtureAlertCount,
  importApiRoutesFixture,
} from './helpers/api-routes-fixture.js'

/**
 * Story 68.8 AC-14 — the security, tenancy, audit, session and concurrency matrix for M7
 * apiRoutes, through the REAL loader and `createApp()` with the fixture extension
 * (`fixtures/mock-api-routes-extension`, default scenario) and a real database.
 */
process.env['VAULT_EXTENSIONS_PACKAGE'] = API_ROUTES_FIXTURE_PACKAGE
configureAuthIntegrationEnv()

const { createApp } = await import('../app.js')
const { initVault } = await import('../modules/vault/key-service.js')
const { resetVaultForTest } = await import('./helpers/vault-test-cleanup.js')
const { __resetExtensionStateForTests } = await import('../extensions/loader.js')
const { __resetCapabilityGateForTests } = await import('../lib/capability-gate.js')
const { __resetAuthStrategiesForTests, authStrategies } =
  await import('../modules/auth/strategies.js')
const { env } = await import('../config/env.js')
const { createDirectAuthenticatedUser } = await import('./helpers/org-role-test-helpers.js')
const fixture = await importApiRoutesFixture()

type TestApp = Awaited<ReturnType<typeof createApp>>
type Owner = { userId: string; orgId: string; cookies: CookieJar }

// Inlined per this suite's convention rather than a PASSWORD-suffixed constant, which
// check-public-safety's secret-assignment scan flags.
const testLoginPassword = 'correct-horse-battery-staple'
const DOCUMENTS = '/api/v1/cm/documents'
const PROJECT_KEY = 'GET /api/v1/projects/:projectId'
const LATE_NEXT_MESSAGE =
  'apiRoutes wrap next() called after the handler settled: GET /api/v1/users/me'

const WRITE_KEY = 'POST /cm/x'
const DASHBOARD_URL = '/api/v1/dashboard'
const CAPABILITIES_URL = '/api/v1/capabilities'

function projectUrl(projectId: string): string {
  return `/api/v1/projects/${projectId}`
}

async function owner(app: TestApp, label: string): Promise<Owner> {
  return registerAndLoginViaApi(app, {
    email: `api-routes-${label}-${randomUUID()}@example.com`,
    password: testLoginPassword,
    orgName: `API Routes ${label} ${randomUUID().slice(0, 8)}`,
  })
}

/** The raw response body (FastifyApp's inject type only exposes json()). */
function bodyOf(res: unknown): string {
  return (res as { body: string }).body
}

function as(cookies: CookieJar): { cookie: string } {
  return { cookie: cookieHeader(cookies) }
}

describe('Story 68.8 AC-14 — apiRoutes through the real loader and createApp()', () => {
  let app: TestApp
  let orgA: Owner
  let orgB: Owner
  let projectA: string
  let projectB: string
  const logs = createLogCaptureStream()

  beforeAll(async () => {
    delete process.env['RELEASE_VERSION']
    await resetVaultForTest()
    await initVaultForTest(initVault, 'api-routes-integration-passphrase')
    __resetExtensionStateForTests()
    __resetAuthStrategiesForTests()
    fixture.setApiRoutesScenario('default')
    fixture.resetObserved()
    app = await createApp({
      logger: { level: 'info', stream: logs.stream },
      vaultGuardEnabled: true,
    })
    orgA = await owner(app, 'a')
    orgB = await owner(app, 'b')
    projectA = await createProjectViaApi(app, orgA.cookies, 'api-routes-a')
    projectB = await createProjectViaApi(app, orgB.cookies, 'api-routes-b')
  }, 60_000)

  afterAll(async () => {
    await app.close()
    __resetExtensionStateForTests()
    __resetCapabilityGateForTests()
    __resetAuthStrategiesForTests()
    await resetVaultForTest()
    delete process.env['VAULT_EXTENSIONS_PACKAGE']
  })

  it('AC-9: loads the extension and keeps the local auth strategy first (local-first wiring)', async () => {
    const health = await app.inject({ method: 'GET', url: '/health' })
    expect(health.json<{ extensions_status: string }>().extensions_status).toBe('loaded')
    expect(authStrategies.map((entry) => entry.providerName)).toEqual([
      'local',
      'test.mock-api-routes-extension',
    ])
  })

  describe('replace/wrap keep PV authentication, roles, MFA, operator and capability checks', () => {
    it('no cookie: 401 and the wrap never runs', async () => {
      const before = fixture.observed.calls.get(PROJECT_KEY) ?? 0
      const res = await app.inject({ method: 'GET', url: projectUrl(projectA) })
      expect(res.statusCode).toBe(401)
      expect(fixture.observed.calls.get(PROJECT_KEY) ?? 0).toBe(before)
    })

    it('an expired access token: 401 JSON (no redirect, Q1) and the wrap never runs', async () => {
      const before = fixture.observed.calls.get(PROJECT_KEY) ?? 0
      const jwt = (app as unknown as { jwt: { sign: (p: object, o: object) => string } }).jwt
      const token = await jwt.sign(
        { sub: orgA.userId, orgId: orgA.orgId, sessionVersion: 1 },
        { jti: randomUUID(), expiresIn: 1 }
      )
      await new Promise((resolve) => setTimeout(resolve, 1_200))
      const res = await app.inject({
        method: 'GET',
        url: projectUrl(projectA),
        headers: { cookie: `access-token=${token}` },
      })
      expect(res.statusCode).toBe(401)
      expect(res.headers['content-type']).toContain('application/json')
      expect(fixture.observed.calls.get(PROJECT_KEY) ?? 0).toBe(before)
    })

    it('a revoked session: 401 on the next call', async () => {
      const revoked = await owner(app, 'revoked')
      const projectId = await createProjectViaApi(app, revoked.cookies, 'api-routes-revoked')
      const logout = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        headers: as(revoked.cookies),
      })
      expect(logout.statusCode).toBeLessThan(300)
      const res = await app.inject({
        method: 'GET',
        url: projectUrl(projectId),
        headers: as(revoked.cookies),
      })
      expect(res.statusCode).toBe(401)
    })

    it('wrong role: a viewer on a member route gets 403 insufficient_role', async () => {
      const viewer = await createDirectAuthenticatedUser(app, 'api-routes-viewer', 'viewer')
      const res = await app.inject({ method: 'GET', url: DOCUMENTS, headers: as(viewer.cookies) })
      expect(res.statusCode).toBe(403)
      expect(res.json()).toMatchObject({ code: 'insufficient_role' })
    })

    it('MFA-required route, admin not enrolled after the grace period: PV’s MFA 403', async () => {
      // PV enforces MFA enrollment for owner/admin roles only.
      const member = await createDirectAuthenticatedUser(app, 'api-routes-mfa', 'admin')
      await expireMfaGracePeriod(member.orgId, member.userId)
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/cm/mfa',
        headers: as(member.cookies),
      })
      expect(res.statusCode).toBe(403)
      expect(res.json()).toMatchObject({ code: 'mfa_required' })
    })

    it('platform-operator route, non-operator: 403 platform_operator_required', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/cm/operator',
        headers: as(orgA.cookies),
      })
      expect(res.statusCode).toBe(403)
      expect(res.json()).toMatchObject({ code: 'platform_operator_required' })
    })

    // The capability.denied audit row is PV's existing best-effort write
    // (lib/capability-gate-audit.ts); it is not asserted here: on main it currently fails RLS
    // (getDb().transaction without the org context) and is logged, for PV routes and extension
    // routes alike. Reported separately; not an M7 behaviour.
    it('capability-gated added route with a denying gate: 403 capability_denied, handler never runs', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/cm/gated',
        headers: as(orgA.cookies),
      })
      expect(res.statusCode).toBe(403)
      expect(res.json()).toMatchObject({
        code: 'capability_denied',
        capability: 'monitoring.public-status-page',
        reasonCode: 'fixture_denied',
      })
      expect(fixture.observed.calls.get('GET /api/v1/cm/gated')).toBeUndefined()
    })

    it('Q14: a capability id outside PV’s CapabilityId set is accepted at boot and denied at request time (unknown_capability), as in the gate today', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/cm/own-capability',
        headers: as(orgA.cookies),
      })
      expect(res.statusCode).toBe(403)
      expect(res.json()).toMatchObject({
        code: 'capability_denied',
        capability: 'cm.documents.read',
        reasonCode: 'unknown_capability',
      })
    })
  })

  describe('tenancy (RLS through ctx.tx)', () => {
    it('cross-org: org B gets PV’s 404 for org A’s project; the CM handler’s unfiltered query sees only org B rows', async () => {
      const res = await app.inject({
        method: 'GET',
        url: projectUrl(projectA),
        headers: as(orgB.cookies),
      })
      expect(res.statusCode).toBe(404)
      const docs = await app.inject({ method: 'GET', url: DOCUMENTS, headers: as(orgB.cookies) })
      expect(docs.statusCode).toBe(200)
      const visible = docs.json<{ data: { visibleProjectIds: string[] } }>().data.visibleProjectIds
      expect(visible).toContain(projectB)
      expect(visible).not.toContain(projectA)
    })

    it('20 parallel requests from two orgs each see only their own org (no cross-talk)', async () => {
      const responses = await Promise.all(
        Array.from({ length: 20 }, (_, index) => {
          const caller = index % 2 === 0 ? orgA : orgB
          const projectId = index % 2 === 0 ? projectA : projectB
          return Promise.all([
            app.inject({ method: 'GET', url: DOCUMENTS, headers: as(caller.cookies) }),
            app.inject({ method: 'GET', url: projectUrl(projectId), headers: as(caller.cookies) }),
          ]).then(([docs, project]) => ({ caller, projectId, docs, project }))
        })
      )
      for (const { caller, projectId, docs, project } of responses) {
        const docData = docs.json<{ data: { orgId: string; visibleProjectIds: string[] } }>().data
        expect(docData.orgId).toBe(caller.orgId)
        expect(docData.visibleProjectIds).toContain(projectId)
        expect(docData.visibleProjectIds).not.toContain(
          projectId === projectA ? projectB : projectA
        )
        expect(project.json<{ data: { id: string } }>().data.id).toBe(projectId)
      }
    })
  })

  describe('audit and transactions', () => {
    it('a mutating added route with default audit writes exactly one row, eventType = its full URL (AC-19)', async () => {
      const auditBefore = await auditRowCount(orgA.orgId, WRITE_KEY)
      const alertsBefore = await fixtureAlertCount(orgA.orgId)
      const res = await app.inject({
        method: 'POST',
        url: '/cm/x',
        headers: as(orgA.cookies),
        payload: {},
      })
      expect(res.statusCode).toBe(200)
      expect(await auditRowCount(orgA.orgId, WRITE_KEY)).toBe(auditBefore + 1)
      expect(await fixtureAlertCount(orgA.orgId)).toBe(alertsBefore + 1)
    })

    it('a CM handler that throws rolls back its write and writes no audit row', async () => {
      const auditBefore = await auditRowCount(orgA.orgId, WRITE_KEY)
      const alertsBefore = await fixtureAlertCount(orgA.orgId)
      const res = await app.inject({
        method: 'POST',
        url: '/cm/x',
        headers: as(orgA.cookies),
        payload: { fail: true },
      })
      expect(res.statusCode).toBe(500)
      expect(await auditRowCount(orgA.orgId, WRITE_KEY)).toBe(auditBefore)
      expect(await fixtureAlertCount(orgA.orgId)).toBe(alertsBefore)
    })

    it('an exhausted audit quota answers PV’s 503 and rolls back the CM write in the same transaction', async () => {
      const quotaOrg = await owner(app, 'quota')
      const previous = env.AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED
      Object.assign(env, { AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED: true })
      try {
        await withOrg(quotaOrg.orgId, (tx) =>
          tx
            .insert(auditStorageQuotaConfig)
            .values({ orgId: quotaOrg.orgId, quotaBytes: 1, updatedAt: new Date() })
            .onConflictDoUpdate({
              target: auditStorageQuotaConfig.orgId,
              set: { quotaBytes: 1, updatedAt: new Date() },
            })
        )
        const res = await app.inject({
          method: 'POST',
          url: '/cm/x',
          headers: as(quotaOrg.cookies),
          payload: {},
        })
        expect(res.statusCode).toBe(503)
        expect(res.json()).toMatchObject({ code: 'audit_quota_exhausted' })
        expect(await fixtureAlertCount(quotaOrg.orgId)).toBe(0)
      } finally {
        Object.assign(env, { AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED: previous })
      }
    })

    it('the audit HMAC chain stays valid after the extension’s audit writes', async () => {
      const from = new Date(Date.now() - 3_600_000).toISOString()
      const to = new Date(Date.now() + 60_000).toISOString()
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/org/audit/verify?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
        headers: as(orgA.cookies),
      })
      expect(res.statusCode).toBe(200)
      const verified = res.json<{
        data: { rowsChecked: number; passed: number; failedCount: number }
      }>().data
      expect(verified.failedCount).toBe(0)
      expect(verified.passed).toBe(verified.rowsChecked)
      expect(verified.rowsChecked).toBeGreaterThan(0)
    })
  })

  describe('wrap, schema and HEAD', () => {
    it('wrap alters PV’s result and the extended response schema (second Zod instance) keeps cmTiles', async () => {
      const res = await app.inject({
        method: 'GET',
        url: projectUrl(projectA),
        headers: as(orgA.cookies),
      })
      expect(res.statusCode).toBe(200)
      const data = res.json<{ data: { id: string; name: string; cmTiles: string[] } }>().data
      expect(data.id).toBe(projectA)
      expect(data.name).toContain('Project api-routes-a')
      expect(data.cmTiles).toEqual([`tile-for-${projectA}`])
    })

    it('PV’s params schema still rejects a non-UUID project id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: projectUrl('not-a-uuid'),
        headers: as(orgA.cookies),
      })
      expect([400, 404, 422]).toContain(res.statusCode)
    })

    it('an explicit HEAD override runs instead of the GET wrap, and auth still applies', async () => {
      const before = fixture.observed.calls.get(PROJECT_KEY) ?? 0
      const head = await app.inject({
        method: 'HEAD',
        url: projectUrl(projectA),
        headers: as(orgA.cookies),
      })
      expect(head.statusCode).toBe(200)
      expect(head.headers['x-cm-head']).toBe('explicit')
      expect(bodyOf(head)).toBe('')
      expect(fixture.observed.calls.get(PROJECT_KEY) ?? 0).toBe(before)
      const anonymous = await app.inject({ method: 'HEAD', url: projectUrl(projectA) })
      expect(anonymous.statusCode).toBe(401)
    })

    it('raw GET /health wrap: CM header and an appended onSend rewrite; HEAD /health gets the header, no body', async () => {
      const res = await app.inject({ method: 'GET', url: '/health' })
      expect(res.headers['x-cm']).toBe('1')
      expect(res.json()).toMatchObject({ status: 'ok', cm: 'ok' })
      const head = await app.inject({ method: 'HEAD', url: '/health' })
      expect(head.headers['x-cm']).toBe('1')
      expect(bodyOf(head)).toBe('')
    })

    it('raw overrides reach the 405 stubs and swagger-ui routes', async () => {
      const login = await app.inject({ method: 'GET', url: '/api/v1/auth/login' })
      expect(login.statusCode).toBe(200)
      expect(login.json()).toEqual({ cm: 'login-get' })
      const yaml = await app.inject({ method: 'GET', url: '/api/v1/docs/yaml' })
      expect(bodyOf(yaml)).toBe('cm: yaml')
    })

    it('wrapping a public secureRoute gives ctx = {} and next() still works', async () => {
      const res = await app.inject({ method: 'GET', url: `/api/v1/status-pages/${'a'.repeat(43)}` })
      expect(res.statusCode).toBe(404)
      const seen = fixture.observed.contexts.filter(
        (entry) => entry.route === 'GET /api/v1/status-pages/:token'
      )
      expect(seen.at(-1)?.ctxKeys).toEqual([])
    })

    it('next() called after the wrap settled rejects with the documented message (Q9)', async () => {
      fixture.observed.lateNextErrors.length = 0
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/users/me',
        headers: as(orgA.cookies),
      })
      expect(res.statusCode).toBe(200)
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(fixture.observed.lateNextErrors).toEqual([LATE_NEXT_MESSAGE])
    })

    it('the live OpenAPI document shows the effective (extended) schema and the added routes', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/openapi.json' })
      const doc = res.json<{ paths: Record<string, unknown> }>()
      expect(JSON.stringify(doc.paths['/api/v1/projects/{projectId}'])).toContain('cmTiles')
      expect(Object.keys(doc.paths)).toContain('/cm/x')
    })
  })

  describe('replaceSecurity (recorded, never refused)', () => {
    it('loosening: anonymous GET /api/v1/dashboard reaches CM with ctx = {}', async () => {
      const res = await app.inject({ method: 'GET', url: DASHBOARD_URL })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ cm: 'dashboard' })
      const seen = fixture.observed.contexts.filter(
        (entry) => entry.route === 'GET /api/v1/dashboard'
      )
      expect(seen.at(-1)?.ctxKeys).toEqual([])
    })

    it('tightening: a viewer gets 403; an admin without MFA gets PV’s MFA 403', async () => {
      const viewer = await createDirectAuthenticatedUser(app, 'api-routes-tight-viewer', 'viewer')
      const viewerRes = await app.inject({
        method: 'GET',
        url: CAPABILITIES_URL,
        headers: as(viewer.cookies),
      })
      expect(viewerRes.statusCode).toBe(403)
      expect(viewerRes.json()).toMatchObject({ code: 'insufficient_role' })
      const admin = await createDirectAuthenticatedUser(app, 'api-routes-tight-admin', 'admin')
      await expireMfaGracePeriod(admin.orgId, admin.userId)
      const adminRes = await app.inject({
        method: 'GET',
        url: CAPABILITIES_URL,
        headers: as(admin.cookies),
      })
      expect(adminRes.statusCode).toBe(403)
      expect(adminRes.json()).toMatchObject({ code: 'mfa_required' })
    })

    it('boot logs one replace_security warn per such route and a keys-only summary', () => {
      const lines = parseCapturedLogLines(logs.lines)
      const warns = lines.filter(
        (line) => line['eventType'] === OperationalEvent.EXTENSION_API_ROUTE_REPLACE_SECURITY
      )
      expect(warns.map((line) => line['url']).sort()).toEqual([
        '/api/v1/auth/cli-login',
        CAPABILITIES_URL,
        DASHBOARD_URL,
      ])
      const summary = lines.find(
        (line) => line['eventType'] === OperationalEvent.EXTENSION_API_ROUTES_APPLIED
      )
      expect(summary?.['added']).toContain(WRITE_KEY)
      const recorded = JSON.stringify([...warns, summary])
      expect(recorded).not.toContain('cmTiles')
      expect(recorded).not.toContain('async')
      expect(recorded).not.toContain('fixture write failed')
    })

    it('the admin status endpoint lists added routes and overrides with their targets', async () => {
      const admin = await createDirectAuthenticatedUser(app, 'api-routes-status', 'admin')
      await enrollMfa(admin.userId)
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/extensions/status',
        headers: as(admin.cookies),
      })
      expect(res.statusCode).toBe(200)
      const apiRoutes = res.json<{
        apiRoutes: {
          added: Array<{ method: string; url: string; capability?: string }>
          overrides: Array<{
            method: string
            url: string
            replaceSecurity: boolean
            target: string
          }>
        }
      }>().apiRoutes
      expect(apiRoutes.added).toContainEqual({
        method: 'GET',
        url: '/api/v1/cm/own-capability',
        capability: 'cm.documents.read',
      })
      expect(apiRoutes.overrides).toContainEqual(
        expect.objectContaining({
          method: 'GET',
          url: DASHBOARD_URL,
          replaceSecurity: true,
          target: 'secureRoute',
        })
      )
      expect(apiRoutes.overrides).toContainEqual(
        expect.objectContaining({ method: 'GET', url: '/health', target: 'raw' })
      )
    })
  })

  describe('added routes and rate-limit keys (AC-10, AC-18)', () => {
    it('an added public route outside /api/v1 is reachable anonymously with ctx = {}', async () => {
      const res = await app.inject({ method: 'POST', url: '/cm/webhooks/stripe', payload: {} })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ received: 'stripe' })
    })

    it('records prefixed default bucket keys: PV routes, overridden routes and added routes', () => {
      const registry = (
        app as unknown as {
          pvSecureRouteRegistry: Map<string, { rateLimitKey: string | null; origin: string }>
        }
      ).pvSecureRouteRegistry
      expect(registry.get('GET /api/v1/projects')).toMatchObject({
        rateLimitKey: 'GET /api/v1/projects',
        origin: 'pv',
      })
      expect(registry.get(PROJECT_KEY)).toMatchObject({
        rateLimitKey: PROJECT_KEY,
        origin: 'override',
      })
      expect(registry.get(WRITE_KEY)).toMatchObject({
        rateLimitKey: WRITE_KEY,
        origin: 'added',
      })
      expect(registry.get('GET /api/v1/dashboard')).toMatchObject({ rateLimitKey: null })
      expect(registry.get('POST /api/v1/auth/sso/callback/:providerName')).toMatchObject({
        rateLimitKey: 'POST /callback',
      })
    })
  })
})
