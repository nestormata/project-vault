import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withOrg } from '@project-vault/db'
import { securityAlerts, serviceEndpoints } from '@project-vault/db/schema'
import { insertTestProject } from '@project-vault/db/test-helpers'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  registerAndLoginViaApi,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import {
  createCredentialViaApi,
  createCredentialTestProject,
} from '../credentials/credential-route-test-helpers.js'
import {
  getBatchedProjectCredentialStats,
  getBatchedProjectServiceHealthStats,
  getOrgDashboardData,
  getProjectDashboardData,
} from './dashboard-stats.js'
import { bootProjectRouteTestApp } from './project-route-test-bootstrap.js'

const { createApp, initVault } = await bootstrapRouteIntegrationTest()

type TestApp = Awaited<ReturnType<typeof createApp>>

const PASSWORD = 'correct-horse-battery-staple'
const PROJECTS_URL = '/api/v1/projects'
const DASHBOARD_URL = '/api/v1/dashboard'

// Fixed relative to PostgreSQL now() during integration tests.
const STRIPE_EXPIRES = '2026-07-15T00:00:00.000Z'
const LEGACY_EXPIRES = '2026-06-01T00:00:00.000Z'

async function registerOwner(app: TestApp, label: string) {
  return registerAndLoginViaApi(app, {
    email: `dashboard-${label}-${randomUUID()}@example.com`,
    password: PASSWORD,
    orgName: `Dashboard ${label} ${randomUUID()}`,
  })
}

async function seedPaymentsFixture(app: TestApp, cookies: Record<string, string>) {
  const paymentsId = await createCredentialTestProject(app, cookies, 'payments')
  const infraId = await createCredentialTestProject(app, cookies, 'infra')

  const stripe = await createCredentialViaApi(app, cookies, paymentsId, {
    name: 'Stripe Secret Key',
    value: 'sk_test_stripe',
    expiresAt: STRIPE_EXPIRES,
  })
  await createCredentialViaApi(app, cookies, paymentsId, {
    name: 'Legacy API Token',
    value: 'legacy-token',
    expiresAt: LEGACY_EXPIRES,
  })
  await createCredentialViaApi(app, cookies, paymentsId, {
    name: 'Internal Service Key',
    value: 'internal-key',
  })

  return { paymentsId, infraId, stripeId: stripe.id }
}

async function fetchProjectListItems(app: TestApp, cookies: Record<string, string>) {
  const response = await app.inject({
    method: 'GET',
    url: PROJECTS_URL,
    headers: { cookie: cookieHeader(cookies) },
  })
  expect(response.statusCode).toBe(200)
  return response.json<{
    data: {
      items: { id: string; credentialCount: number; expiringCount: number; alertCount: number }[]
    }
  }>().data.items
}

async function seedSecurityAlert(
  orgId: string,
  status: 'PENDING_DELIVERY' | 'delivered' | 'dismissed'
) {
  await withOrg(orgId, (tx) =>
    tx.insert(securityAlerts).values({
      orgId,
      alertType: 'security.failed_auth_threshold',
      severity: 'critical',
      status,
      payload: {},
    })
  )
}

describe.sequential('dashboard stats', () => {
  let app: TestApp

  beforeAll(async () => {
    app = await bootProjectRouteTestApp(createApp, initVault)
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  it('fixture catalog → project list credentialCount / expiringCount', async () => {
    const owner = await registerOwner(app, 'list-counts')
    const { paymentsId, infraId } = await seedPaymentsFixture(app, owner.cookies)

    const items = await fetchProjectListItems(app, owner.cookies)

    const payments = items.find((item) => item.id === paymentsId)
    const infra = items.find((item) => item.id === infraId)
    expect(payments).toMatchObject({
      credentialCount: 3,
      expiringCount: 1,
      alertCount: 0,
    })
    expect(infra).toMatchObject({
      credentialCount: 0,
      expiringCount: 0,
      alertCount: 0,
    })
  }, 30_000)

  it('project dashboard credentialStats {1,1,1}', async () => {
    const owner = await registerOwner(app, 'project-dashboard')
    const { paymentsId } = await seedPaymentsFixture(app, owner.cookies)

    const response = await app.inject({
      method: 'GET',
      url: `${PROJECTS_URL}/${paymentsId}/dashboard`,
      headers: { cookie: cookieHeader(owner.cookies) },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      data: {
        credentialStats: { active: 1, expiringSoon: 1, expired: 1 },
        upcomingRotations: [],
        monitoredServiceHealth: { healthy: 0, degraded: 0, down: 0 },
        recentAccessEvents: [],
        unresolvedAlertCount: 0,
        isEmpty: false,
        suggestedActions: [],
      },
    })
  }, 30_000)

  it('GET /api/v1/dashboard total + expiring list (≤20 items)', async () => {
    const owner = await registerOwner(app, 'org-dashboard')
    const { paymentsId, stripeId } = await seedPaymentsFixture(app, owner.cookies)

    const response = await app.inject({
      method: 'GET',
      url: DASHBOARD_URL,
      headers: { cookie: cookieHeader(owner.cookies) },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      data: {
        totalCredentials: 3,
        expiringWithin30Days: {
          count: 1,
          items: [
            {
              id: stripeId,
              name: 'Stripe Secret Key',
              projectId: paymentsId,
              expiresAt: STRIPE_EXPIRES,
            },
          ],
        },
        projectsWithOverdueRotations: { count: 0, items: [] },
        unresolvedAlertCount: 0,
      },
    })
    expect(
      response.json<{ data: { expiringWithin30Days: { items: unknown[] } } }>().data
        .expiringWithin30Days.items
    ).toHaveLength(1)
  }, 30_000)

  it('Org Beta user → 0 credentials / empty items (RLS isolation)', async () => {
    const ownerA = await registerOwner(app, 'org-alpha')
    await seedPaymentsFixture(app, ownerA.cookies)

    const ownerB = await registerOwner(app, 'org-beta')
    const response = await app.inject({
      method: 'GET',
      url: DASHBOARD_URL,
      headers: { cookie: cookieHeader(ownerB.cookies) },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      data: {
        totalCredentials: 0,
        expiringWithin30Days: { count: 0, items: [] },
        projectsWithOverdueRotations: { count: 0, items: [] },
        unresolvedAlertCount: 0,
      },
    })
  }, 30_000)

  it('batched project stats use a single aggregate query for 50 projects', async () => {
    const owner = await registerOwner(app, 'query-count')
    const projectIds: string[] = []
    for (let index = 0; index < 50; index += 1) {
      const project = await insertTestProject(owner.orgId, {
        userId: owner.userId,
        slug: `stats-${index}`,
      })
      projectIds.push(project.id)
    }

    await withOrg(owner.orgId, async (tx) => {
      let selectCount = 0
      const countingTx = new Proxy(tx, {
        get(target, property, receiver) {
          if (property === 'select') {
            selectCount += 1
          }
          return Reflect.get(target, property, receiver)
        },
      })

      await getBatchedProjectCredentialStats(countingTx, projectIds)
      expect(selectCount).toBe(1)
    })
  }, 30_000)

  it('getProjectDashboardData marks empty projects with suggested actions', async () => {
    const owner = await registerOwner(app, 'empty-dashboard')
    const { infraId } = await seedPaymentsFixture(app, owner.cookies)

    await withOrg(owner.orgId, async (tx) => {
      const dashboard = await getProjectDashboardData(tx, infraId)
      expect(dashboard).toMatchObject({
        credentialStats: { active: 0, expiringSoon: 0, expired: 0 },
        isEmpty: true,
        suggestedActions: ['add_credential', 'add_service', 'import_credentials'],
      })
    })
  }, 30_000)

  it('getOrgDashboardData includes project names on expiring items', async () => {
    const owner = await registerOwner(app, 'org-names')
    const { paymentsId } = await seedPaymentsFixture(app, owner.cookies)

    await withOrg(owner.orgId, async (tx) => {
      const dashboard = await getOrgDashboardData(tx)
      expect(dashboard.expiringWithin30Days.items[0]).toMatchObject({
        projectId: paymentsId,
        projectName: expect.stringMatching(/payments/i),
      })
    })
  }, 30_000)

  it('org dashboard unresolvedAlertCount excludes dismissed alerts (AC-10)', async () => {
    const owner = await registerOwner(app, 'org-alert-count')

    await withOrg(owner.orgId, async (tx) => {
      const before = await getOrgDashboardData(tx)
      expect(before.unresolvedAlertCount).toBe(0)
    })

    await seedSecurityAlert(owner.orgId, 'delivered')
    await seedSecurityAlert(owner.orgId, 'dismissed')

    await withOrg(owner.orgId, async (tx) => {
      const after = await getOrgDashboardData(tx)
      expect(after.unresolvedAlertCount).toBe(1)
    })
  }, 30_000)

  it('project list alertCount stays 0 even with unresolved org security alerts (AC-12, ADR-3.4-02)', async () => {
    const owner = await registerOwner(app, 'list-alertcount-zero')
    const { paymentsId } = await seedPaymentsFixture(app, owner.cookies)
    await seedSecurityAlert(owner.orgId, 'delivered')

    const items = await fetchProjectListItems(app, owner.cookies)
    const payments = items.find((item) => item.id === paymentsId)
    expect(payments?.alertCount).toBe(0)
  }, 30_000)

  it('project dashboard monitoredServiceHealth reflects real service_endpoints counts (Story 6.2 AC 15)', async () => {
    const owner = await registerOwner(app, 'service-health')
    const projectId = await createCredentialTestProject(app, owner.cookies, 'svc-health')

    async function insertEndpoint(status: 'healthy' | 'degraded' | 'down') {
      await withOrg(owner.orgId, (tx) =>
        tx.insert(serviceEndpoints).values({
          orgId: owner.orgId,
          projectId,
          name: `${status}-endpoint`,
          url: `https://${status}.example.com/health`,
          status,
          consecutiveFailures: status === 'healthy' ? 0 : 1,
        })
      )
    }
    await insertEndpoint('healthy')
    await insertEndpoint('healthy')
    await insertEndpoint('healthy')
    await insertEndpoint('degraded')
    await insertEndpoint('down')

    const response = await app.inject({
      method: 'GET',
      url: `${PROJECTS_URL}/${projectId}/dashboard`,
      headers: { cookie: cookieHeader(owner.cookies) },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      data: {
        monitoredServiceHealth: { healthy: 3, degraded: 1, down: 1 },
        isEmpty: false,
      },
    })
  }, 30_000)

  it('getBatchedProjectServiceHealthStats groups service_endpoints.status per project (Story 6.2 AC 15)', async () => {
    const owner = await registerOwner(app, 'service-health-batch')
    const projectId = await createCredentialTestProject(app, owner.cookies, 'svc-health-batch')

    await withOrg(owner.orgId, (tx) =>
      tx.insert(serviceEndpoints).values([
        {
          orgId: owner.orgId,
          projectId,
          name: 'a',
          url: 'https://a.example.com/health',
          status: 'healthy',
        },
        {
          orgId: owner.orgId,
          projectId,
          name: 'b',
          url: 'https://b.example.com/health',
          status: 'down',
          consecutiveFailures: 3,
        },
      ])
    )

    await withOrg(owner.orgId, async (tx) => {
      const stats = await getBatchedProjectServiceHealthStats(tx, [projectId])
      expect(stats.get(projectId)).toEqual({ healthy: 1, degraded: 0, down: 1 })
    })
  }, 30_000)

  it('project dashboard unresolvedAlertCount mirrors the org-wide count (AC-11, ADR-3.4-01)', async () => {
    const owner = await registerOwner(app, 'project-alert-count')
    const { paymentsId, infraId } = await seedPaymentsFixture(app, owner.cookies)

    await seedSecurityAlert(owner.orgId, 'PENDING_DELIVERY')
    await seedSecurityAlert(owner.orgId, 'delivered')
    await seedSecurityAlert(owner.orgId, 'dismissed')

    await withOrg(owner.orgId, async (tx) => {
      const paymentsDashboard = await getProjectDashboardData(tx, paymentsId)
      const infraDashboard = await getProjectDashboardData(tx, infraId)
      expect(paymentsDashboard.unresolvedAlertCount).toBe(2)
      expect(infraDashboard.unresolvedAlertCount).toBe(2)
    })
  }, 30_000)
})
