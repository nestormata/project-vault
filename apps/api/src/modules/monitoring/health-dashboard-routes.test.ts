import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withOrg } from '@project-vault/db'
import { serviceEndpoints } from '@project-vault/db/schema'
import { cookieHeader, createProjectViaApi } from '../../__tests__/helpers/auth-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import { bootstrapCredentialRouteOwners } from '../credentials/credential-route-test-helpers.js'
import { monitoringIntegration } from './monitoring-integration-context.js'

const { createApp, initVault } = monitoringIntegration
type TestApp = Awaited<ReturnType<typeof createApp>>
type Cookies = Record<string, string>

const TEST_PASSPHRASE = 'health-dashboard-routes-passphrase'
const PASSWORD = 'correct-horse-battery-staple'
const HEALTH_DASHBOARD_URL = '/api/v1/health-dashboard'

async function insertEndpoint(
  orgId: string,
  projectId: string,
  status: 'healthy' | 'degraded' | 'down',
  name = `${status}-endpoint`
) {
  await withOrg(orgId, (tx) =>
    tx.insert(serviceEndpoints).values({
      orgId,
      projectId,
      name,
      url: `https://${name}.example.com/health`,
      status,
      consecutiveFailures: status === 'healthy' ? 0 : 1,
    })
  )
}

function getHealthDashboard(app: TestApp, cookies: Cookies) {
  return app.inject({
    method: 'GET',
    url: HEALTH_DASHBOARD_URL,
    headers: { cookie: cookieHeader(cookies) },
  })
}

describe.sequential('GET /api/v1/health-dashboard (Story 6.3, Section A)', () => {
  let app: TestApp
  let owner: { userId: string; orgId: string; cookies: Cookies }
  let other: { userId: string; orgId: string; cookies: Cookies }

  beforeAll(async () => {
    const bootstrap = await bootstrapCredentialRouteOwners(
      createApp,
      initVault,
      TEST_PASSPHRASE,
      PASSWORD,
      'health-dashboard'
    )
    app = bootstrap.app
    owner = bootstrap.owner
    other = bootstrap.other
  }, 30_000)

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  it('returns projects grouped with their services and an org-wide summary (AC 1 happy path)', async () => {
    const projectA = await createProjectViaApi(app, owner.cookies, 'hd-a')
    const projectB = await createProjectViaApi(app, owner.cookies, 'hd-b')
    await insertEndpoint(owner.orgId, projectA, 'healthy')
    await insertEndpoint(owner.orgId, projectA, 'down')
    await insertEndpoint(owner.orgId, projectB, 'degraded')

    const res = await getHealthDashboard(app, owner.cookies)
    expect(res.statusCode).toBe(200)
    const body = res.json<{
      data: {
        projects: { projectId: string; services: { status: string }[] }[]
        summary: { healthy: number; degraded: number; down: number }
      }
    }>()

    const byId = new Map(body.data.projects.map((p) => [p.projectId, p]))
    expect(byId.get(projectA)?.services).toHaveLength(2)
    expect(byId.get(projectB)?.services).toHaveLength(1)
    expect(body.data.summary.healthy).toBeGreaterThanOrEqual(1)
    expect(body.data.summary.degraded).toBeGreaterThanOrEqual(1)
    expect(body.data.summary.down).toBeGreaterThanOrEqual(1)
  })

  it('returns an empty dashboard (200, not 404) when no services exist anywhere for a fresh org', async () => {
    const freshOwner = await bootstrapCredentialRouteOwners(
      createApp,
      initVault,
      TEST_PASSPHRASE,
      PASSWORD,
      'health-dashboard-empty'
    )
    const res = await getHealthDashboard(freshOwner.app, freshOwner.owner.cookies)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      data: { projects: [], summary: { healthy: 0, degraded: 0, down: 0 } },
    })
    await freshOwner.app.close()
  })

  it('reports a never-checked service verbatim as healthy with lastCheckedAt null (AC 2)', async () => {
    const projectId = await createProjectViaApi(app, owner.cookies, 'hd-never-checked')
    await withOrg(owner.orgId, (tx) =>
      tx.insert(serviceEndpoints).values({
        orgId: owner.orgId,
        projectId,
        name: 'fresh-endpoint',
        url: 'https://fresh-endpoint.example.com/health',
      })
    )

    const res = await getHealthDashboard(app, owner.cookies)
    expect(res.statusCode).toBe(200)
    const body = res.json<{
      data: { projects: { projectId: string; services: Record<string, unknown>[] }[] }
    }>()
    const project = body.data.projects.find((p) => p.projectId === projectId)
    expect(project?.services[0]).toMatchObject({
      name: 'fresh-endpoint',
      status: 'healthy',
      lastCheckedAt: null,
    })
  })

  it('returns 401 with no session cookie (AC 4)', async () => {
    const res = await app.inject({ method: 'GET', url: HEALTH_DASHBOARD_URL })
    expect(res.statusCode).toBe(401)
  })

  it("never exposes another organization's projects/services (AC 5, RLS isolation)", async () => {
    const projectId = await createProjectViaApi(app, other.cookies, 'hd-other-org')
    await insertEndpoint(other.orgId, projectId, 'down')

    const res = await getHealthDashboard(app, owner.cookies)
    expect(res.statusCode).toBe(200)
    const body = res.json<{ data: { projects: { projectId: string }[] } }>()
    expect(body.data.projects.some((p) => p.projectId === projectId)).toBe(false)
  })

  it('enforces the 120/min LIST_RATE_LIMIT and returns 429 on the 121st request (AC 6)', async () => {
    process.env['RATE_LIMIT_TEST_ENFORCE'] = 'true'
    try {
      const rateLimitOwner = await bootstrapCredentialRouteOwners(
        createApp,
        initVault,
        TEST_PASSPHRASE,
        PASSWORD,
        'health-dashboard-rate-limit'
      )
      let last: Awaited<ReturnType<typeof getHealthDashboard>> | undefined
      for (let i = 0; i < 121; i += 1) {
        last = await getHealthDashboard(rateLimitOwner.app, rateLimitOwner.owner.cookies)
      }
      expect(last?.statusCode).toBe(429)
      await rateLimitOwner.app.close()
    } finally {
      delete process.env['RATE_LIMIT_TEST_ENFORCE']
    }
  }, 30_000)
})
