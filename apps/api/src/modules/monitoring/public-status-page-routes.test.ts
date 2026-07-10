import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { projects, serviceEndpoints } from '@project-vault/db/schema'
import {
  cookieHeader,
  createProjectViaApi,
  initVaultForTest,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import { createMembershipTestHelpers } from '../../__tests__/helpers/membership-test-helpers.js'
import { monitoringIntegration } from './monitoring-integration-context.js'

const { createApp, initVault } = monitoringIntegration
type TestApp = Awaited<ReturnType<typeof createApp>>
type Cookies = Record<string, string>

const TEST_PASSPHRASE = 'public-status-page-routes-passphrase'

function statusPageUrl(projectId: string): string {
  return `/api/v1/projects/${projectId}/status-page`
}

function enableStatusPage(app: TestApp, cookies: Cookies, projectId: string) {
  return app.inject({
    method: 'POST',
    url: statusPageUrl(projectId),
    headers: { cookie: cookieHeader(cookies) },
    payload: {},
  })
}

function putStatusPage(
  app: TestApp,
  cookies: Cookies,
  projectId: string,
  services: { serviceId: string; displayName: string }[]
) {
  return app.inject({
    method: 'PUT',
    url: statusPageUrl(projectId),
    headers: { cookie: cookieHeader(cookies) },
    payload: { services },
  })
}

function publicStatusPage(app: TestApp, token: string) {
  // Deliberately no cookie/Authorization header — this route is public, unauthenticated.
  return app.inject({ method: 'GET', url: `/api/v1/status-pages/${encodeURIComponent(token)}` })
}

async function insertEndpoint(orgId: string, projectId: string, name: string) {
  const [row] = await withOrg(orgId, (tx) =>
    tx
      .insert(serviceEndpoints)
      .values({
        orgId,
        projectId,
        name,
        url: `https://${name}.example.com/health`,
        status: 'healthy',
      })
      .returning()
  )
  if (!row) throw new Error('expected service endpoint to be inserted')
  return row.id
}

describe.sequential('public status page route (Story 6.3, Section E)', () => {
  let app: TestApp
  const { registerOwner } = createMembershipTestHelpers({
    emailPrefix: 'public-status-page',
    orgNamePrefix: 'PublicStatusPage',
  })

  beforeAll(async () => {
    await resetVaultForTest()
    await initVaultForTest(initVault, TEST_PASSPHRASE)
    app = await createApp({ logger: false, vaultGuardEnabled: true })
  }, 30_000)

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  it('returns the configured services with no internal identifiers (happy path, AC 12)', async () => {
    const owner = await registerOwner(app, 'happy')
    const projectId = await createProjectViaApi(app, owner.cookies, 'psp-happy')
    const svcA = await insertEndpoint(owner.orgId, projectId, 'payments')
    const svcB = await insertEndpoint(owner.orgId, projectId, 'auth')
    const enableRes = await enableStatusPage(app, owner.cookies, projectId)
    const token = enableRes.json<{ data: { token: string } }>().data.token
    await putStatusPage(app, owner.cookies, projectId, [
      { serviceId: svcA, displayName: 'Payments API' },
      { serviceId: svcB, displayName: 'Auth Service' },
    ])

    const res = await publicStatusPage(app, token)
    expect(res.statusCode).toBe(200)
    const body = res.json<{ data: { services: Record<string, unknown>[] } }>()
    expect(body.data.services).toEqual([
      { displayName: 'Payments API', status: 'healthy', lastCheckedAt: null },
      { displayName: 'Auth Service', status: 'healthy', lastCheckedAt: null },
    ])

    // Explicit negative assertion (realignment-review finding): grep the serialized response
    // for forbidden fields, not just presence of allowed ones.
    const raw = JSON.stringify(body)
    for (const forbidden of [
      'serviceId',
      'projectId',
      'orgId',
      svcA,
      svcB,
      'payments.example.com',
      'auth.example.com',
    ]) {
      expect(raw).not.toContain(forbidden)
    }
  })

  it('sets Cache-Control: no-store so an intermediate proxy never serves a stale state', async () => {
    const owner = await registerOwner(app, 'cache-control')
    const projectId = await createProjectViaApi(app, owner.cookies, 'psp-cache-control')
    const enableRes = await enableStatusPage(app, owner.cookies, projectId)
    const token = enableRes.json<{ data: { token: string } }>().data.token

    const res = await publicStatusPage(app, token)
    expect(res.headers['cache-control']).toBe('no-store')
  })

  it('returns 404 for an unknown token', async () => {
    const res = await publicStatusPage(app, 'a-token-that-was-never-issued-1234567890')
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ code: 'status_page_not_found' })
  })

  it('returns 404 for a token that was disabled', async () => {
    const owner = await registerOwner(app, 'disabled')
    const projectId = await createProjectViaApi(app, owner.cookies, 'psp-disabled')
    const enableRes = await enableStatusPage(app, owner.cookies, projectId)
    const token = enableRes.json<{ data: { token: string } }>().data.token

    const deleteRes = await app.inject({
      method: 'DELETE',
      url: statusPageUrl(projectId),
      headers: { cookie: cookieHeader(owner.cookies) },
    })
    expect(deleteRes.statusCode).toBe(204)

    const res = await publicStatusPage(app, token)
    expect(res.statusCode).toBe(404)
  })

  it('returns 404 once the project is archived, even though the status page row itself was never disabled (code-review finding)', async () => {
    const owner = await registerOwner(app, 'archived-project')
    const projectId = await createProjectViaApi(app, owner.cookies, 'psp-archived-project')
    const svc = await insertEndpoint(owner.orgId, projectId, 'archived-project-svc')
    const enableRes = await enableStatusPage(app, owner.cookies, projectId)
    const token = enableRes.json<{ data: { token: string } }>().data.token
    await putStatusPage(app, owner.cookies, projectId, [
      { serviceId: svc, displayName: 'Archived Project Service' },
    ])

    // Sanity check: the public page works before archival.
    const before = await publicStatusPage(app, token)
    expect(before.statusCode).toBe(200)

    // Archive the project directly (own withOrg call, committed immediately — mirrors
    // health-dashboard-service.test.ts's documented pattern for avoiding an open-transaction
    // deadlock against the afterAll cleanup).
    await withOrg(owner.orgId, (tx) =>
      tx.update(projects).set({ archivedAt: new Date() }).where(eq(projects.id, projectId))
    )

    // The status_pages row itself was never disabled/deleted — only the underlying project was
    // archived. The public link must stop resolving anyway (same 404 as an unknown/disabled
    // token), not keep serving a decommissioned project's live status indefinitely.
    const after = await publicStatusPage(app, token)
    expect(after.statusCode).toBe(404)
    expect(after.json()).toMatchObject({ code: 'status_page_not_found' })
  })

  it('returns an empty services array when the status page has no services configured yet (edge, AC 12)', async () => {
    const owner = await registerOwner(app, 'empty')
    const projectId = await createProjectViaApi(app, owner.cookies, 'psp-empty')
    const enableRes = await enableStatusPage(app, owner.cookies, projectId)
    const token = enableRes.json<{ data: { token: string } }>().data.token

    const res = await publicStatusPage(app, token)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ data: { services: [] } })
  })

  it('stores and serves an HTML-shaped displayName as literal text (AC 15 injection example)', async () => {
    const owner = await registerOwner(app, 'injection')
    const projectId = await createProjectViaApi(app, owner.cookies, 'psp-injection')
    const svc = await insertEndpoint(owner.orgId, projectId, 'injection-svc')
    const enableRes = await enableStatusPage(app, owner.cookies, projectId)
    const token = enableRes.json<{ data: { token: string } }>().data.token
    const injected = '<script>alert(1)</script>&"quoted"'
    await putStatusPage(app, owner.cookies, projectId, [{ serviceId: svc, displayName: injected }])

    const res = await publicStatusPage(app, token)
    expect(res.statusCode).toBe(200)
    expect(
      res.json<{ data: { services: { displayName: string }[] } }>().data.services[0]?.displayName
    ).toBe(injected)
  })

  it('resolves correctly with no org context set at all (ADR-6.3-09 step 4, RLS coverage exception)', async () => {
    const orgA = await registerOwner(app, 'rls-exception-a')
    const projectId = await createProjectViaApi(app, orgA.cookies, 'psp-rls-exception')
    const enableRes = await enableStatusPage(app, orgA.cookies, projectId)
    const token = enableRes.json<{ data: { token: string } }>().data.token

    // The request below carries no cookie/session at all — no org context is ever set for it,
    // proving the admin-connection point lookup (findStatusPageByTokenHash) is the deliberate,
    // tested RLS exception documented in ADR-6.3-09, not an oversight. Mirrors the
    // "documents refresh_tokens as an RLS coverage exception" pattern for a table that IS
    // RLS-protected (unlike refresh_tokens, which is excluded outright) but has one narrow,
    // precedented point-lookup path around it.
    const res = await publicStatusPage(app, token)
    expect(res.statusCode).toBe(200)
  })

  it('enforces the 60/min per-IP rate limit shared across tokens', async () => {
    process.env['RATE_LIMIT_TEST_BYPASS'] = 'false'
    try {
      const owner = await registerOwner(app, 'rate-limit')
      const projectId = await createProjectViaApi(app, owner.cookies, 'psp-rate-limit')
      const enableRes = await enableStatusPage(app, owner.cookies, projectId)
      const token = enableRes.json<{ data: { token: string } }>().data.token

      let last: Awaited<ReturnType<typeof publicStatusPage>> | undefined
      for (let i = 0; i < 61; i += 1) {
        last = await publicStatusPage(app, token)
      }
      expect(last?.statusCode).toBe(429)
    } finally {
      delete process.env['RATE_LIMIT_TEST_BYPASS']
    }
  }, 30_000)
})
