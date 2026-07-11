import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import {
  auditLogEntries,
  monitoringAlerts,
  notificationQueue,
  serviceEndpoints,
} from '@project-vault/db/schema'
import {
  cookieHeader,
  createProjectViaApi,
  expectAuditWriteFailed,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import { bootstrapCredentialRouteOwners } from '../credentials/credential-route-test-helpers.js'
import { createMembershipTestHelpers } from '../../__tests__/helpers/membership-test-helpers.js'
import { monitoringIntegration } from './monitoring-integration-context.js'
import {
  expectArchivedProjectRejected,
  expectCrossOrgProjectNotFound,
} from './monitoring-route-test-helpers.js'

const PUBLIC_IP = '8.8.8.8'
const lookupMock = vi.fn(async (..._args: unknown[]) => [{ address: PUBLIC_IP, family: 4 }])
vi.mock('node:dns/promises', () => ({
  default: {
    lookup: (...args: unknown[]) => (lookupMock as (...a: unknown[]) => unknown)(...args),
  },
}))

const { createApp, initVault, humanAudit } = monitoringIntegration
type TestApp = Awaited<ReturnType<typeof createApp>>
type Cookies = Record<string, string>

const TEST_PASSPHRASE = 'service-endpoints-routes-passphrase'
const PASSWORD = 'correct-horse-battery-staple'
const DEFAULT_ENDPOINT_URL = 'https://api.example.com/health'
const SERVICE_DOWN_ALERT_TYPE = 'service.down'

function baseUrl(projectId: string): string {
  return `/api/v1/projects/${projectId}/service-endpoints`
}
function itemUrl(projectId: string, id: string): string {
  return `${baseUrl(projectId)}/${id}`
}

function createEndpoint(
  app: TestApp,
  cookies: Cookies,
  projectId: string,
  body: Record<string, unknown> = { name: 'API health', url: DEFAULT_ENDPOINT_URL }
) {
  return app.inject({
    method: 'POST',
    url: baseUrl(projectId),
    headers: { cookie: cookieHeader(cookies) },
    payload: body,
  })
}

async function createEndpointExpect201(
  app: TestApp,
  cookies: Cookies,
  projectId: string,
  body?: Record<string, unknown>
) {
  const res = await createEndpoint(app, cookies, projectId, body)
  expect(res.statusCode).toBe(201)
  return res.json<{ data: { id: string; [key: string]: unknown } }>().data
}

describe.sequential('service-endpoints / health-history / alerts routes (Story 6.2)', () => {
  let app: TestApp
  let owner: { userId: string; orgId: string; cookies: Cookies }
  let other: { userId: string; orgId: string; cookies: Cookies }
  const { addUserToOrg } = createMembershipTestHelpers({
    emailPrefix: 'svc-endpoint',
    orgNamePrefix: 'SvcEndpoint',
  })

  beforeAll(async () => {
    const bootstrap = await bootstrapCredentialRouteOwners(
      createApp,
      initVault,
      TEST_PASSPHRASE,
      PASSWORD,
      'svc-endpoint'
    )
    app = bootstrap.app
    owner = bootstrap.owner
    other = bootstrap.other
  }, 30_000)

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  afterEach(() => {
    lookupMock.mockClear()
    lookupMock.mockImplementation(async () => [{ address: PUBLIC_IP, family: 4 }])
  })

  describe('POST /:projectId/service-endpoints', () => {
    it('creates an endpoint with defaults applied (happy path)', async () => {
      const projectId = await createProjectViaApi(app, owner.cookies, 'se-happy')
      const data = await createEndpointExpect201(app, owner.cookies, projectId)

      expect(data).toMatchObject({
        name: 'API health',
        url: DEFAULT_ENDPOINT_URL,
        checkFrequencyMinutes: 5,
        downThresholdFailures: 2,
        status: 'healthy',
        consecutiveFailures: 0,
        lastCheckedAt: null,
        projectId,
      })
      expect(data['downEpisodeStartedAt']).toBeUndefined()
    })

    it('accepts explicit non-default frequency/threshold (edge path)', async () => {
      const projectId = await createProjectViaApi(app, owner.cookies, 'se-edge')
      const data = await createEndpointExpect201(app, owner.cookies, projectId, {
        name: 'Batch API',
        url: 'https://batch.example.com/ping',
        checkFrequencyMinutes: 15,
        downThresholdFailures: 3,
      })
      expect(data['checkFrequencyMinutes']).toBe(15)
      expect(data['downThresholdFailures']).toBe(3)
    })

    it('redacts userinfo and secret-shaped query params in the response and audit payload (ADR-6.2-11)', async () => {
      const projectId = await createProjectViaApi(app, owner.cookies, 'se-redact')
      const data = await createEndpointExpect201(app, owner.cookies, projectId, {
        name: 'Partner ping',
        url: 'https://svc:hunter2@partner.example.com/ping?apikey=sk_live_abc123',
      })
      expect(data['url']).toBe('https://partner.example.com/ping?apikey=***REDACTED***')

      const rows = await withOrg(owner.orgId, (tx) =>
        tx
          .select({ payload: auditLogEntries.payload })
          .from(auditLogEntries)
          .where(eq(auditLogEntries.eventType, 'service_endpoint.created'))
      )
      const match = rows.find((r) => (r.payload as Record<string, unknown>)['url'] === data['url'])
      expect(match).toBeDefined()
    })

    it('rejects missing name/url with 422', async () => {
      const projectId = await createProjectViaApi(app, owner.cookies, 'se-invalid')
      const missingName = await createEndpoint(app, owner.cookies, projectId, {
        url: DEFAULT_ENDPOINT_URL,
      })
      expect(missingName.statusCode).toBe(422)

      const missingUrl = await createEndpoint(app, owner.cookies, projectId, { name: 'No URL' })
      expect(missingUrl.statusCode).toBe(422)

      const badFrequency = await createEndpoint(app, owner.cookies, projectId, {
        name: 'Bad freq',
        url: DEFAULT_ENDPOINT_URL,
        checkFrequencyMinutes: 7,
      })
      expect(badFrequency.statusCode).toBe(422)

      const badThreshold = await createEndpoint(app, owner.cookies, projectId, {
        name: 'Bad threshold',
        url: DEFAULT_ENDPOINT_URL,
        downThresholdFailures: 0,
      })
      expect(badThreshold.statusCode).toBe(422)
    })

    it('rejects a private/loopback/metadata URL with 422 url_not_allowed (AC 1/2)', async () => {
      const projectId = await createProjectViaApi(app, owner.cookies, 'se-ssrf')
      lookupMock.mockImplementation(async () => [{ address: '127.0.0.1', family: 4 }])
      const res = await createEndpoint(app, owner.cookies, projectId, {
        name: 'Internal',
        url: 'http://internal.example.com/admin',
      })
      expect(res.statusCode).toBe(422)
      expect(res.json()).toMatchObject({ code: 'url_not_allowed' })
    })

    it('rejects at the registration cap before any SSRF validation or write (ADR-6.2-09)', async () => {
      const projectId = await createProjectViaApi(app, owner.cookies, 'se-cap')
      // MAX_SERVICE_ENDPOINTS_PER_PROJECT default is 25; create up to the cap.
      for (let i = 0; i < 25; i++) {
        const res = await createEndpoint(app, owner.cookies, projectId, {
          name: `Endpoint ${i}`,
          url: `https://svc-${i}.example.com/health`,
        })
        expect(res.statusCode).toBe(201)
      }
      const overCap = await createEndpoint(app, owner.cookies, projectId, {
        name: 'One too many',
        url: 'https://svc-over.example.com/health',
      })
      expect(overCap.statusCode).toBe(422)
      expect(overCap.json()).toMatchObject({ code: 'service_endpoint_limit_reached' })
    }, 30_000)

    it('returns 404 project_not_found for a project outside the caller org', async () => {
      await expectCrossOrgProjectNotFound(app, owner.cookies, other.cookies, 'se', createEndpoint)
    })

    it('returns 410 for an archived project', async () => {
      await expectArchivedProjectRejected(app, owner.cookies, 'se', createEndpoint)
    })

    it('rolls back creation when the audit write fails', async () => {
      const projectId = await createProjectViaApi(app, owner.cookies, 'se-audit-fail')
      const auditSpy = vi
        .spyOn(humanAudit, 'writeHumanAuditEntry')
        .mockRejectedValueOnce(new Error('forced audit failure'))
      try {
        const res = await createEndpoint(app, owner.cookies, projectId)
        expectAuditWriteFailed(res)
      } finally {
        auditSpy.mockRestore()
      }
    })
  })

  describe('GET /:projectId/service-endpoints', () => {
    it('lists endpoints for the project', async () => {
      const projectId = await createProjectViaApi(app, owner.cookies, 'se-list')
      await createEndpointExpect201(app, owner.cookies, projectId)
      const res = await app.inject({
        method: 'GET',
        url: baseUrl(projectId),
        headers: { cookie: cookieHeader(owner.cookies) },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json<{ data: { items: unknown[] } }>().data.items.length).toBeGreaterThan(0)
    })
  })

  describe('GET /:projectId/service-endpoints/:id', () => {
    it('returns the endpoint (200, full detail shape)', async () => {
      const projectId = await createProjectViaApi(app, owner.cookies, 'se-get')
      const created = await createEndpointExpect201(app, owner.cookies, projectId)

      const res = await app.inject({
        method: 'GET',
        url: itemUrl(projectId, created['id'] as string),
        headers: { cookie: cookieHeader(owner.cookies) },
      })
      expect(res.statusCode).toBe(200)
      const data = res.json<{ data: Record<string, unknown> }>().data
      expect(data['id']).toBe(created['id'])
      expect(data['name']).toBe(created['name'])
      expect(data['url']).toBe(DEFAULT_ENDPOINT_URL)
      expect(data['status']).toBeDefined()
    })

    it('returns 404 for a cross-org id', async () => {
      const projectId = await createProjectViaApi(app, owner.cookies, 'se-get-404')
      const res = await app.inject({
        method: 'GET',
        url: itemUrl(projectId, randomUUID()),
        headers: { cookie: cookieHeader(owner.cookies) },
      })
      expect(res.statusCode).toBe(404)
      expect(res.json()).toMatchObject({ code: 'service_endpoint_not_found' })
    })

    it('requires member+ role — a viewer gets 403 (same minimumRole as the list route)', async () => {
      const projectId = await createProjectViaApi(app, owner.cookies, 'se-get-403')
      const created = await createEndpointExpect201(app, owner.cookies, projectId)
      const viewer = await addUserToOrg(app, owner.orgId, 'se-get-viewer', { orgRole: 'viewer' })

      const res = await app.inject({
        method: 'GET',
        url: itemUrl(projectId, created['id'] as string),
        headers: { cookie: cookieHeader(viewer.cookies) },
      })
      expect(res.statusCode).toBe(403)
    })

    it('allows a plain member (the minimumRole boundary) to read', async () => {
      const projectId = await createProjectViaApi(app, owner.cookies, 'se-get-member')
      const created = await createEndpointExpect201(app, owner.cookies, projectId)
      const member = await addUserToOrg(app, owner.orgId, 'se-get-member', { orgRole: 'member' })

      const res = await app.inject({
        method: 'GET',
        url: itemUrl(projectId, created['id'] as string),
        headers: { cookie: cookieHeader(member.cookies) },
      })
      expect(res.statusCode).toBe(200)
    })
  })

  describe('PATCH /:projectId/service-endpoints/:id', () => {
    it('updates checkFrequencyMinutes (happy path)', async () => {
      const projectId = await createProjectViaApi(app, owner.cookies, 'se-patch')
      const created = await createEndpointExpect201(app, owner.cookies, projectId)

      const res = await app.inject({
        method: 'PATCH',
        url: itemUrl(projectId, created['id'] as string),
        headers: { cookie: cookieHeader(owner.cookies) },
        payload: { checkFrequencyMinutes: 1 },
      })
      expect(res.statusCode).toBe(200)
      expect(
        res.json<{ data: { checkFrequencyMinutes: number } }>().data.checkFrequencyMinutes
      ).toBe(1)
    })

    it('re-validates url on update and rejects a private target', async () => {
      const projectId = await createProjectViaApi(app, owner.cookies, 'se-patch-ssrf')
      const created = await createEndpointExpect201(app, owner.cookies, projectId)

      lookupMock.mockImplementation(async () => [{ address: '169.254.169.254', family: 4 }])
      const res = await app.inject({
        method: 'PATCH',
        url: itemUrl(projectId, created['id'] as string),
        headers: { cookie: cookieHeader(owner.cookies) },
        payload: { url: 'http://internal.example.com/' },
      })
      expect(res.statusCode).toBe(422)
    })

    it('returns 404 for a cross-org id and 422 for an invalid checkFrequencyMinutes', async () => {
      const projectId = await createProjectViaApi(app, owner.cookies, 'se-patch-404')
      const created = await createEndpointExpect201(app, owner.cookies, projectId)

      const crossOrgRes = await app.inject({
        method: 'PATCH',
        url: itemUrl(projectId, randomUUID()),
        headers: { cookie: cookieHeader(owner.cookies) },
        payload: { name: 'x' },
      })
      expect(crossOrgRes.statusCode).toBe(404)

      const badFreq = await app.inject({
        method: 'PATCH',
        url: itemUrl(projectId, created['id'] as string),
        headers: { cookie: cookieHeader(owner.cookies) },
        payload: { checkFrequencyMinutes: 3 },
      })
      expect(badFreq.statusCode).toBe(422)
    })
  })

  describe('DELETE /:projectId/service-endpoints/:id', () => {
    it('deletes the endpoint, suppresses pending notifications, and resolves active alerts', async () => {
      const projectId = await createProjectViaApi(app, owner.cookies, 'se-delete')
      const created = await createEndpointExpect201(app, owner.cookies, projectId)

      // Seed a pending notification + an active monitoring alert referencing this endpoint,
      // simulating state the health-check worker would have produced (AC 3 edge case).
      let seededAlertId = ''
      await withOrg(owner.orgId, async (tx) => {
        await tx.insert(notificationQueue).values({
          orgId: owner.orgId,
          recipientUserId: owner.userId,
          channel: 'inbox',
          templateId: SERVICE_DOWN_ALERT_TYPE,
          payload: { serviceEndpointId: created['id'] },
          status: 'pending',
        })
        const [alert] = await tx
          .insert(monitoringAlerts)
          .values({
            orgId: owner.orgId,
            projectId,
            serviceEndpointId: created['id'] as string,
            alertType: SERVICE_DOWN_ALERT_TYPE,
            severity: 'critical',
            episodeKey: `${created['id']}:seed`,
            status: 'snoozed',
          })
          .returning({ id: monitoringAlerts.id })
        seededAlertId = alert?.id ?? ''
      })

      const res = await app.inject({
        method: 'DELETE',
        url: itemUrl(projectId, created['id'] as string),
        headers: { cookie: cookieHeader(owner.cookies) },
      })
      expect(res.statusCode).toBe(204)

      const [remainingEndpoint] = await withOrg(owner.orgId, (tx) =>
        tx
          .select()
          .from(serviceEndpoints)
          .where(eq(serviceEndpoints.id, created['id'] as string))
      )
      expect(remainingEndpoint).toBeUndefined()

      const [queueRow] = await withOrg(owner.orgId, (tx) =>
        tx
          .select({ status: notificationQueue.status })
          .from(notificationQueue)
          .where(
            sql`${notificationQueue.payload}->>'serviceEndpointId' = ${created['id'] as string}`
          )
      )
      expect(queueRow?.status).toBe('suppressed')

      // The alert row must survive the endpoint's deletion (ON DELETE SET NULL, not CASCADE) —
      // look it up by its own stable id since serviceEndpointId is nulled out at delete time.
      const [alertRow] = await withOrg(owner.orgId, (tx) =>
        tx
          .select({
            status: monitoringAlerts.status,
            serviceEndpointId: monitoringAlerts.serviceEndpointId,
          })
          .from(monitoringAlerts)
          .where(eq(monitoringAlerts.id, seededAlertId))
      )
      expect(alertRow?.status).toBe('resolved_by_deletion')
      expect(alertRow?.serviceEndpointId).toBeNull()
    })

    it('returns 404 for a cross-org id', async () => {
      const projectId = await createProjectViaApi(app, owner.cookies, 'se-delete-404')
      const res = await app.inject({
        method: 'DELETE',
        url: itemUrl(projectId, randomUUID()),
        headers: { cookie: cookieHeader(owner.cookies) },
      })
      expect(res.statusCode).toBe(404)
    })
  })

  describe('GET /:projectId/service-endpoints/:id/health-history', () => {
    it('returns an empty page with default limit 50 for a brand-new endpoint', async () => {
      const projectId = await createProjectViaApi(app, owner.cookies, 'se-health-history')
      const created = await createEndpointExpect201(app, owner.cookies, projectId)

      const res = await app.inject({
        method: 'GET',
        url: `${itemUrl(projectId, created['id'] as string)}/health-history`,
        headers: { cookie: cookieHeader(owner.cookies) },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json<{ data: { items: unknown[]; limit: number; hasNext: boolean } }>()
      expect(body.data.items).toEqual([])
      expect(body.data.limit).toBe(50)
      expect(body.data.hasNext).toBe(false)
    })

    it('rejects limit > 200 with 422 and a cross-org id with 404', async () => {
      const projectId = await createProjectViaApi(app, owner.cookies, 'se-health-history-422')
      const created = await createEndpointExpect201(app, owner.cookies, projectId)

      const badLimit = await app.inject({
        method: 'GET',
        url: `${itemUrl(projectId, created['id'] as string)}/health-history?limit=500`,
        headers: { cookie: cookieHeader(owner.cookies) },
      })
      expect(badLimit.statusCode).toBe(422)

      const crossOrg = await app.inject({
        method: 'GET',
        url: `${itemUrl(projectId, randomUUID())}/health-history`,
        headers: { cookie: cookieHeader(owner.cookies) },
      })
      expect(crossOrg.statusCode).toBe(404)
    })
  })

  describe('alerts: GET /:projectId/alerts, snooze, dismiss (AC 9/10/17)', () => {
    async function seedAlert(
      projectId: string,
      serviceEndpointId: string,
      overrides: Partial<typeof monitoringAlerts.$inferInsert> = {}
    ) {
      const [row] = await withOrg(owner.orgId, (tx) =>
        tx
          .insert(monitoringAlerts)
          .values({
            orgId: owner.orgId,
            projectId,
            serviceEndpointId,
            alertType: SERVICE_DOWN_ALERT_TYPE,
            severity: 'critical',
            episodeKey: `${serviceEndpointId}:${randomUUID()}`,
            status: 'active',
            ...overrides,
          })
          .returning()
      )
      if (!row) throw new Error('seedAlert insert returned no row')
      return row
    }

    it('lists alerts for the project, discoverable for snooze/dismiss (AC 17/ADR-6.2-10)', async () => {
      const projectId = await createProjectViaApi(app, owner.cookies, 'se-alerts-list')
      const endpoint = await createEndpointExpect201(app, owner.cookies, projectId)
      const alert = await seedAlert(projectId, endpoint['id'] as string)

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${projectId}/alerts`,
        headers: { cookie: cookieHeader(owner.cookies) },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json<{ data: { items: { id: string }[] } }>()
      expect(body.data.items.some((item) => item.id === alert.id)).toBe(true)
    })

    it('filters by status=active, excluding dismissed alerts', async () => {
      const projectId = await createProjectViaApi(app, owner.cookies, 'se-alerts-filter')
      const endpoint = await createEndpointExpect201(app, owner.cookies, projectId)
      const active = await seedAlert(projectId, endpoint['id'] as string)
      const dismissed = await seedAlert(projectId, endpoint['id'] as string, {
        alertType: 'service.recovery',
        severity: 'info',
        status: 'dismissed',
      })

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${projectId}/alerts?status=active`,
        headers: { cookie: cookieHeader(owner.cookies) },
      })
      const body = res.json<{ data: { items: { id: string }[] } }>()
      expect(body.data.items.some((item) => item.id === active.id)).toBe(true)
      expect(body.data.items.some((item) => item.id === dismissed.id)).toBe(false)
    })

    it('snoozes an alert (happy path) and extends snoozedUntil on re-snooze (finding 14)', async () => {
      const projectId = await createProjectViaApi(app, owner.cookies, 'se-snooze')
      const endpoint = await createEndpointExpect201(app, owner.cookies, projectId)
      const alert = await seedAlert(projectId, endpoint['id'] as string)

      const first = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${projectId}/alerts/${alert.id}/snooze`,
        headers: { cookie: cookieHeader(owner.cookies) },
        payload: { durationMinutes: 60 },
      })
      expect(first.statusCode).toBe(200)
      const firstBody = first.json<{ data: { status: string; snoozedUntil: string } }>()
      expect(firstBody.data.status).toBe('snoozed')

      const second = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${projectId}/alerts/${alert.id}/snooze`,
        headers: { cookie: cookieHeader(owner.cookies) },
        payload: { durationMinutes: 30 },
      })
      expect(second.statusCode).toBe(200)
      const secondBody = second.json<{ data: { snoozedUntil: string } }>()
      expect(new Date(secondBody.data.snoozedUntil).getTime()).not.toBe(
        new Date(firstBody.data.snoozedUntil).getTime()
      )
    })

    it('rejects snoozing an already-dismissed alert with 409', async () => {
      const projectId = await createProjectViaApi(app, owner.cookies, 'se-snooze-409')
      const endpoint = await createEndpointExpect201(app, owner.cookies, projectId)
      const alert = await seedAlert(projectId, endpoint['id'] as string, { status: 'dismissed' })

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${projectId}/alerts/${alert.id}/snooze`,
        headers: { cookie: cookieHeader(owner.cookies) },
        payload: { durationMinutes: 60 },
      })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ code: 'alert_already_dismissed' })
    })

    it('rejects invalid/oversized durationMinutes with 422', async () => {
      const projectId = await createProjectViaApi(app, owner.cookies, 'se-snooze-422')
      const endpoint = await createEndpointExpect201(app, owner.cookies, projectId)
      const alert = await seedAlert(projectId, endpoint['id'] as string)

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${projectId}/alerts/${alert.id}/snooze`,
        headers: { cookie: cookieHeader(owner.cookies) },
        payload: { durationMinutes: 20_000 },
      })
      expect(res.statusCode).toBe(422)
    })

    it('dismiss requires admin+ role — a member gets 403 (adversarial-review finding 10)', async () => {
      const projectId = await createProjectViaApi(app, owner.cookies, 'se-dismiss-403')
      const endpoint = await createEndpointExpect201(app, owner.cookies, projectId)
      const alert = await seedAlert(projectId, endpoint['id'] as string)
      const member = await addUserToOrg(app, owner.orgId, 'member', { orgRole: 'member' })

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${projectId}/alerts/${alert.id}/dismiss`,
        headers: { cookie: cookieHeader(member.cookies) },
      })
      expect(res.statusCode).toBe(403)
    })

    it('dismisses an alert (happy path), transitions snoozed->dismissed, and is idempotent', async () => {
      const projectId = await createProjectViaApi(app, owner.cookies, 'se-dismiss')
      const endpoint = await createEndpointExpect201(app, owner.cookies, projectId)
      const alert = await seedAlert(projectId, endpoint['id'] as string, { status: 'snoozed' })

      const first = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${projectId}/alerts/${alert.id}/dismiss`,
        headers: { cookie: cookieHeader(owner.cookies) },
      })
      expect(first.statusCode).toBe(200)
      expect(first.json<{ data: { status: string } }>().data.status).toBe('dismissed')

      const second = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${projectId}/alerts/${alert.id}/dismiss`,
        headers: { cookie: cookieHeader(owner.cookies) },
      })
      expect(second.statusCode).toBe(200)
    })

    it('returns 404 for a nonexistent/cross-project alertId', async () => {
      const projectId = await createProjectViaApi(app, owner.cookies, 'se-alert-404')
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${projectId}/alerts/${randomUUID()}/dismiss`,
        headers: { cookie: cookieHeader(owner.cookies) },
      })
      expect(res.statusCode).toBe(404)
    })
  })

  describe('RLS cross-org isolation (AC 13)', () => {
    it('a real service_endpoints/monitoring_alerts row created under org A is invisible (404) to a caller in org B', async () => {
      const orgAProjectId = await createProjectViaApi(app, owner.cookies, 'se-rls-a')
      const endpoint = await createEndpointExpect201(app, owner.cookies, orgAProjectId)
      const [alert] = await withOrg(owner.orgId, (tx) =>
        tx
          .insert(monitoringAlerts)
          .values({
            orgId: owner.orgId,
            projectId: orgAProjectId,
            serviceEndpointId: endpoint['id'] as string,
            alertType: SERVICE_DOWN_ALERT_TYPE,
            severity: 'critical',
            episodeKey: `${endpoint['id']}:rls-test`,
            status: 'active',
          })
          .returning()
      )
      if (!alert) throw new Error('expected alert to be inserted')

      // `other` operates against their OWN org's project — org B has no visibility into org A's
      // projectId/serviceEndpointId/alertId regardless of guessing the right combination.
      const orgBProjectId = await createProjectViaApi(app, other.cookies, 'se-rls-b')

      // No single-item GET route exists for service-endpoints; verify via list instead that the
      // cross-org row never appears when org B lists its own (empty) project's endpoints.
      const listRes = await app.inject({
        method: 'GET',
        url: baseUrl(orgBProjectId),
        headers: { cookie: cookieHeader(other.cookies) },
      })
      expect(listRes.statusCode).toBe(200)
      expect(
        listRes
          .json<{ data: { items: { id: string }[] } }>()
          .data.items.some((item) => item.id === endpoint['id'])
      ).toBe(false)

      const patchRes = await app.inject({
        method: 'PATCH',
        url: itemUrl(orgBProjectId, endpoint['id'] as string),
        headers: { cookie: cookieHeader(other.cookies) },
        payload: { name: 'hijacked' },
      })
      expect(patchRes.statusCode).toBe(404)

      const deleteRes = await app.inject({
        method: 'DELETE',
        url: itemUrl(orgBProjectId, endpoint['id'] as string),
        headers: { cookie: cookieHeader(other.cookies) },
      })
      expect(deleteRes.statusCode).toBe(404)

      const healthHistoryRes = await app.inject({
        method: 'GET',
        url: `${itemUrl(orgBProjectId, endpoint['id'] as string)}/health-history`,
        headers: { cookie: cookieHeader(other.cookies) },
      })
      expect(healthHistoryRes.statusCode).toBe(404)

      const snoozeRes = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${orgBProjectId}/alerts/${alert.id}/snooze`,
        headers: { cookie: cookieHeader(other.cookies) },
        payload: { durationMinutes: 60 },
      })
      expect(snoozeRes.statusCode).toBe(404)

      const dismissRes = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${orgBProjectId}/alerts/${alert.id}/dismiss`,
        headers: { cookie: cookieHeader(other.cookies) },
      })
      expect(dismissRes.statusCode).toBe(404)

      // Confirm the row is still intact and reachable by its real owner (org A).
      const ownerConfirmRes = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${orgAProjectId}/alerts`,
        headers: { cookie: cookieHeader(owner.cookies) },
      })
      expect(
        ownerConfirmRes
          .json<{ data: { items: { id: string }[] } }>()
          .data.items.some((item) => item.id === alert.id)
      ).toBe(true)
    })
  })
})
