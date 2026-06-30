import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withOrg } from '@project-vault/db'
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

    const response = await app.inject({
      method: 'GET',
      url: PROJECTS_URL,
      headers: { cookie: cookieHeader(owner.cookies) },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json<{
      data: {
        items: {
          id: string
          credentialCount: number
          expiringCount: number
          alertCount: number
        }[]
      }
    }>()

    const payments = body.data.items.find((item) => item.id === paymentsId)
    const infra = body.data.items.find((item) => item.id === infraId)
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
})
