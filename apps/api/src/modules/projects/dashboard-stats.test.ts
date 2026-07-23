import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { credentials, securityAlerts, serviceEndpoints } from '@project-vault/db/schema'
import { insertTestProject } from '@project-vault/db/test-helpers'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  registerAndLoginViaApi,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { createMembershipTestHelpers } from '../../__tests__/helpers/membership-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import {
  createCredentialViaApi,
  createCredentialTestProject,
  credentialLifecycleUrl,
} from '../credentials/credential-route-test-helpers.js'
import {
  computeUpcomingRotations,
  getBatchedProjectCredentialStats,
  getBatchedProjectServiceHealthStats,
  getOrgDashboardData,
  getProjectDashboardData,
} from './dashboard-stats.js'
import { bootProjectRouteTestApp } from './project-route-test-bootstrap.js'

/** Hourly cron schedule used to force credentials into an already-overdue state once combined
 *  with `backdateCredentialCreatedAt`. */
const HOURLY_CRON = '0 * * * *'

/** Far enough in the past that any hourly cron schedule is already overdue relative to "now". */
const FAR_PAST_DATE = new Date('2020-01-01T00:00:00.000Z')

/** Backdates a credential's createdAt so a fresh cron schedule computes as already-overdue
 *  relative to "now" (a brand-new credential's reference point is otherwise always "now",
 *  which can never be overdue for a schedule with a >= 1 hour minimum interval). */
async function backdateCredentialCreatedAt(orgId: string, credentialId: string, createdAt: Date) {
  await withOrg(orgId, (tx) =>
    tx.update(credentials).set({ createdAt }).where(eq(credentials.id, credentialId))
  )
}

async function setRotationScheduleViaApi(
  app: TestApp,
  cookies: Record<string, string>,
  projectId: string,
  credentialId: string,
  rotationSchedule: string
) {
  const response = await app.inject({
    method: 'PATCH',
    url: credentialLifecycleUrl(projectId, credentialId),
    headers: { cookie: cookieHeader(cookies) },
    payload: { rotationSchedule },
  })
  expect(response.statusCode).toBe(200)
}

const { createApp, initVault } = await bootstrapRouteIntegrationTest()

type TestApp = Awaited<ReturnType<typeof createApp>>

const PASSWORD = 'correct-horse-battery-staple'
const PROJECTS_URL = '/api/v1/projects'
const DASHBOARD_URL = '/api/v1/dashboard'

// Computed relative to wall-clock "now" so the "expiring soon" (within 30 days) bucket stays
// true regardless of when the suite runs. A hardcoded future date silently becomes past-dated
// (and reclassified as "expired") once real time catches up to it.
const STRIPE_EXPIRES = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString()
// Always in the past — a fixed date works here since "expired" only requires expiresAt <= now.
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
  }, 60_000)

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
        unresolvedAlertCount: 0,
        isEmpty: false,
        // AC-S1: 3 credentials, 0 services (seedPaymentsFixture never adds service_endpoints) →
        // a targeted single suggestion for the missing category, not an empty list.
        suggestedActions: ['add_service'],
      },
    })
    // AC-A1: seedPaymentsFixture's 3 createCredentialViaApi calls each generate a real
    // credential.created audit event — recentAccessEvents now reflects that real history instead
    // of the previously-hardcoded [].
    const body = response.json<{ data: { recentAccessEvents: { eventType: string }[] } }>()
    expect(body.data.recentAccessEvents).toHaveLength(3)
    expect(
      body.data.recentAccessEvents.every((event) => event.eventType === 'credential.created')
    ).toBe(true)
  }, 60_000)

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
  }, 60_000)

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
  }, 60_000)

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
  }, 60_000)

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
  }, 60_000)

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
  }, 60_000)

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
  }, 60_000)

  it('project list alertCount stays 0 even with unresolved org security alerts (AC-12, ADR-3.4-02)', async () => {
    const owner = await registerOwner(app, 'list-alertcount-zero')
    const { paymentsId } = await seedPaymentsFixture(app, owner.cookies)
    await seedSecurityAlert(owner.orgId, 'delivered')

    const items = await fetchProjectListItems(app, owner.cookies)
    const payments = items.find((item) => item.id === paymentsId)
    expect(payments?.alertCount).toBe(0)
  }, 60_000)

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
  }, 60_000)

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
  }, 60_000)

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
  }, 60_000)

  it('Story 5.2 AC-15: org dashboard shows only overdue rotations, project dashboard shows both overdue and pending', async () => {
    const owner = await registerOwner(app, 'rotation-dashboard')
    const projectId = await createCredentialTestProject(app, owner.cookies, 'rotation-dash')

    // Overdue: hourly schedule, backdated far enough that "now" is well past the next tick.
    const overdue = await createCredentialViaApi(app, owner.cookies, projectId, {
      name: 'Overdue Rotation Credential',
      value: 'overdue-value',
    })
    await setRotationScheduleViaApi(app, owner.cookies, projectId, overdue.id, HOURLY_CRON)
    await backdateCredentialCreatedAt(owner.orgId, overdue.id, FAR_PAST_DATE)

    // Pending: monthly schedule computed from "now" — due well within 30 days but not overdue.
    const pending = await createCredentialViaApi(app, owner.cookies, projectId, {
      name: 'Pending Rotation Credential',
      value: 'pending-value',
    })
    await setRotationScheduleViaApi(app, owner.cookies, projectId, pending.id, '0 0 1 * *')

    const orgResponse = await app.inject({
      method: 'GET',
      url: DASHBOARD_URL,
      headers: { cookie: cookieHeader(owner.cookies) },
    })
    expect(orgResponse.statusCode).toBe(200)
    const orgBody = orgResponse.json<{
      data: { projectsWithOverdueRotations: { count: number; items: { credentialId: string }[] } }
    }>()
    const overdueIds = orgBody.data.projectsWithOverdueRotations.items.map(
      (item) => item.credentialId
    )
    expect(overdueIds).toContain(overdue.id)
    expect(overdueIds).not.toContain(pending.id)

    const projectResponse = await app.inject({
      method: 'GET',
      url: `${PROJECTS_URL}/${projectId}/dashboard`,
      headers: { cookie: cookieHeader(owner.cookies) },
    })
    expect(projectResponse.statusCode).toBe(200)
    const projectBody = projectResponse.json<{
      data: { upcomingRotations: { credentialId: string; status: string }[] }
    }>()
    const projectCredentialIds = projectBody.data.upcomingRotations.map((item) => item.credentialId)
    expect(projectCredentialIds).toEqual(expect.arrayContaining([overdue.id, pending.id]))
  }, 60_000)

  it('AC-S1: credentials but no services → suggestedActions is exactly ["add_service"]', async () => {
    const owner = await registerOwner(app, 'partial-services')
    const projectId = await createCredentialTestProject(app, owner.cookies, 'partial-services')
    await createCredentialViaApi(app, owner.cookies, projectId, {
      name: 'Only Credential',
      value: 'sk_only',
    })

    await withOrg(owner.orgId, async (tx) => {
      const dashboard = await getProjectDashboardData(tx, projectId)
      expect(dashboard.isEmpty).toBe(false)
      expect(dashboard.suggestedActions).toEqual(['add_service'])
    })
  }, 60_000)

  it('AC-S1 example 2: services but no credentials → suggestedActions is ["add_credential", "import_credentials"]', async () => {
    const owner = await registerOwner(app, 'partial-credentials')
    const projectId = await createCredentialTestProject(app, owner.cookies, 'partial-credentials')

    await withOrg(owner.orgId, (tx) =>
      tx.insert(serviceEndpoints).values({
        orgId: owner.orgId,
        projectId,
        name: 'only-endpoint',
        url: 'https://only.example.com/health',
        status: 'healthy',
      })
    )

    await withOrg(owner.orgId, async (tx) => {
      const dashboard = await getProjectDashboardData(tx, projectId)
      expect(dashboard.isEmpty).toBe(false)
      expect(dashboard.suggestedActions).toEqual(['add_credential', 'import_credentials'])
    })
  }, 60_000)

  it('AC-S2: both credentials and services present → suggestedActions is []', async () => {
    const owner = await registerOwner(app, 'fully-covered')
    const projectId = await createCredentialTestProject(app, owner.cookies, 'fully-covered')
    await createCredentialViaApi(app, owner.cookies, projectId, {
      name: 'Covered Credential',
      value: 'sk_covered',
    })
    await withOrg(owner.orgId, (tx) =>
      tx.insert(serviceEndpoints).values({
        orgId: owner.orgId,
        projectId,
        name: 'covered-endpoint',
        url: 'https://covered.example.com/health',
        status: 'healthy',
      })
    )

    await withOrg(owner.orgId, async (tx) => {
      const dashboard = await getProjectDashboardData(tx, projectId)
      expect(dashboard.isEmpty).toBe(false)
      expect(dashboard.suggestedActions).toEqual([])
    })
  }, 60_000)

  it('AC-S3 regression: a fully-empty project keeps the existing 3-action suggestion list unchanged', async () => {
    const owner = await registerOwner(app, 'still-empty')
    const projectId = await createCredentialTestProject(app, owner.cookies, 'still-empty')

    await withOrg(owner.orgId, async (tx) => {
      const dashboard = await getProjectDashboardData(tx, projectId)
      expect(dashboard.isEmpty).toBe(true)
      expect(dashboard.suggestedActions).toEqual([
        'add_credential',
        'add_service',
        'import_credentials',
      ])
    })
  }, 60_000)

  it('Story 5.2 AC-14: computeUpcomingRotations excludes a credential with an active in_progress rotation', async () => {
    const owner = await registerOwner(app, 'rotation-active-exclude')
    const projectId = await createCredentialTestProject(app, owner.cookies, 'rotation-active')
    const credential = await createCredentialViaApi(app, owner.cookies, projectId, {
      name: 'Active Rotation Credential',
      value: 'active-value',
    })
    await setRotationScheduleViaApi(app, owner.cookies, projectId, credential.id, HOURLY_CRON)
    await backdateCredentialCreatedAt(owner.orgId, credential.id, FAR_PAST_DATE)

    const initiateResponse = await app.inject({
      method: 'POST',
      url: `${PROJECTS_URL}/${projectId}/credentials/${credential.id}/rotations`,
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { newValue: 'rotated-value' },
    })
    expect(initiateResponse.statusCode).toBe(201)

    await withOrg(owner.orgId, async (tx) => {
      const results = await computeUpcomingRotations(tx, { projectId, horizonDays: 30 })
      expect(results.map((r) => r.credentialId)).not.toContain(credential.id)
    })
  }, 60_000)

  describe('org dashboard project-membership scoping (AC-V6)', () => {
    const { addUserToOrg, addProjectMember } = createMembershipTestHelpers({
      emailPrefix: 'dash-vis',
      orgNamePrefix: 'DashVis',
    })

    it('scopes totalCredentials and expiringWithin30Days to visible projects for an org member', async () => {
      const owner = await registerOwner(app, 'dash-vis-owner')
      const { paymentsId, stripeId } = await seedPaymentsFixture(app, owner.cookies)
      // A second, hidden-to-the-member project with its own expiring credential.
      const hiddenProjectId = await createCredentialTestProject(
        app,
        owner.cookies,
        'dash-vis-hidden'
      )
      await createCredentialViaApi(app, owner.cookies, hiddenProjectId, {
        name: 'Hidden Expiring Key',
        value: 'hidden-value',
        expiresAt: STRIPE_EXPIRES,
      })

      const member = await addUserToOrg(app, owner.orgId, 'dash-vis-member', { orgRole: 'member' })
      await addProjectMember(owner.orgId, paymentsId, member.userId, 'viewer')

      const res = await app.inject({
        method: 'GET',
        url: DASHBOARD_URL,
        headers: { cookie: cookieHeader(member.cookies) },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json<{
        data: {
          totalCredentials: number
          expiringWithin30Days: { count: number; items: { id: string }[] }
        }
      }>()
      // Only the 3 payments-project credentials are visible — the hidden project's credential
      // (and its own expiring item) must not be counted.
      expect(body.data.totalCredentials).toBe(3)
      expect(body.data.expiringWithin30Days.count).toBe(1)
      expect(body.data.expiringWithin30Days.items.map((i) => i.id)).toEqual([stripeId])
    }, 60_000)

    it('returns zero totals for an org member with no project memberships', async () => {
      const owner = await registerOwner(app, 'dash-vis-empty-owner')
      await seedPaymentsFixture(app, owner.cookies)
      const member = await addUserToOrg(app, owner.orgId, 'dash-vis-empty-member', {
        orgRole: 'member',
      })

      const res = await app.inject({
        method: 'GET',
        url: DASHBOARD_URL,
        headers: { cookie: cookieHeader(member.cookies) },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({
        data: {
          totalCredentials: 0,
          expiringWithin30Days: { count: 0, items: [] },
          projectsWithOverdueRotations: { count: 0, items: [] },
        },
      })
    }, 60_000)

    it('scopes projectsWithOverdueRotations to visible projects for an org member', async () => {
      const owner = await registerOwner(app, 'dash-vis-rotation-owner')
      const visibleProjectId = await createCredentialTestProject(
        app,
        owner.cookies,
        'dash-vis-rot-a'
      )
      const hiddenProjectId = await createCredentialTestProject(
        app,
        owner.cookies,
        'dash-vis-rot-b'
      )

      const visibleCredential = await createCredentialViaApi(app, owner.cookies, visibleProjectId, {
        name: 'Visible Overdue Credential',
        value: 'v1',
      })
      await setRotationScheduleViaApi(
        app,
        owner.cookies,
        visibleProjectId,
        visibleCredential.id,
        HOURLY_CRON
      )
      await backdateCredentialCreatedAt(owner.orgId, visibleCredential.id, FAR_PAST_DATE)

      const hiddenCredential = await createCredentialViaApi(app, owner.cookies, hiddenProjectId, {
        name: 'Hidden Overdue Credential',
        value: 'v2',
      })
      await setRotationScheduleViaApi(
        app,
        owner.cookies,
        hiddenProjectId,
        hiddenCredential.id,
        HOURLY_CRON
      )
      await backdateCredentialCreatedAt(owner.orgId, hiddenCredential.id, FAR_PAST_DATE)

      const member = await addUserToOrg(app, owner.orgId, 'dash-vis-rotation-member', {
        orgRole: 'member',
      })
      await addProjectMember(owner.orgId, visibleProjectId, member.userId, 'viewer')

      const res = await app.inject({
        method: 'GET',
        url: DASHBOARD_URL,
        headers: { cookie: cookieHeader(member.cookies) },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json<{
        data: { projectsWithOverdueRotations: { count: number; items: { credentialId: string }[] } }
      }>()
      const overdueIds = body.data.projectsWithOverdueRotations.items.map((i) => i.credentialId)
      expect(overdueIds).toContain(visibleCredential.id)
      expect(overdueIds).not.toContain(hiddenCredential.id)
    }, 60_000)

    it('does not scope any field for an org admin with zero project memberships (regression, AC-V8)', async () => {
      const owner = await registerOwner(app, 'dash-vis-admin-owner')
      const { stripeId } = await seedPaymentsFixture(app, owner.cookies)
      const admin = await addUserToOrg(app, owner.orgId, 'dash-vis-admin-caller', {
        orgRole: 'admin',
      })

      const res = await app.inject({
        method: 'GET',
        url: DASHBOARD_URL,
        headers: { cookie: cookieHeader(admin.cookies) },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json<{
        data: { totalCredentials: number; expiringWithin30Days: { items: { id: string }[] } }
      }>()
      expect(body.data.totalCredentials).toBe(3)
      expect(body.data.expiringWithin30Days.items.map((i) => i.id)).toEqual([stripeId])
    }, 60_000)

    it('unresolvedAlertCount is org-wide and unscoped for both member and admin callers (AC-V6 exemption)', async () => {
      const owner = await registerOwner(app, 'dash-vis-alert-owner')
      await seedPaymentsFixture(app, owner.cookies)
      await seedSecurityAlert(owner.orgId, 'PENDING_DELIVERY')

      const member = await addUserToOrg(app, owner.orgId, 'dash-vis-alert-member', {
        orgRole: 'member',
      })
      const admin = await addUserToOrg(app, owner.orgId, 'dash-vis-alert-admin', {
        orgRole: 'admin',
      })

      const memberRes = await app.inject({
        method: 'GET',
        url: DASHBOARD_URL,
        headers: { cookie: cookieHeader(member.cookies) },
      })
      const adminRes = await app.inject({
        method: 'GET',
        url: DASHBOARD_URL,
        headers: { cookie: cookieHeader(admin.cookies) },
      })
      expect(
        memberRes.json<{ data: { unresolvedAlertCount: number } }>().data.unresolvedAlertCount
      ).toBe(1)
      expect(
        adminRes.json<{ data: { unresolvedAlertCount: number } }>().data.unresolvedAlertCount
      ).toBe(1)
    }, 60_000)
  })
})
