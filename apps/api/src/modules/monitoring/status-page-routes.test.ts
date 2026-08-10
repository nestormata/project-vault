import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import {
  auditLogEntries,
  orgMemberships,
  serviceEndpoints,
  statusPages,
} from '@project-vault/db/schema'
import {
  cookieHeader,
  createProjectViaApi,
  expectAuditWriteFailed,
  initVaultForTest,
  registerAndLoginViaApi,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import { createMembershipTestHelpers } from '../../__tests__/helpers/membership-test-helpers.js'
import { monitoringIntegration } from './monitoring-integration-context.js'

const { createApp, initVault, humanAudit } = monitoringIntegration
type TestApp = Awaited<ReturnType<typeof createApp>>
type Cookies = Record<string, string>

const TEST_PASSPHRASE = 'status-page-routes-passphrase'
const PAYMENTS_API_DISPLAY_NAME = 'Payments API'

function statusPageUrl(projectId: string): string {
  return `/api/v1/projects/${projectId}/status-page`
}
function regenerateUrl(projectId: string): string {
  return `${statusPageUrl(projectId)}/regenerate`
}

async function insertEndpoint(orgId: string, projectId: string, name = 'svc') {
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

function enableStatusPage(app: TestApp, cookies: Cookies, projectId: string) {
  return app.inject({
    method: 'POST',
    url: statusPageUrl(projectId),
    headers: { cookie: cookieHeader(cookies) },
    payload: {},
  })
}

function getStatusPage(app: TestApp, cookies: Cookies, projectId: string) {
  return app.inject({
    method: 'GET',
    url: statusPageUrl(projectId),
    headers: { cookie: cookieHeader(cookies) },
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

function deleteStatusPage(app: TestApp, cookies: Cookies, projectId: string) {
  return app.inject({
    method: 'DELETE',
    url: statusPageUrl(projectId),
    headers: { cookie: cookieHeader(cookies) },
  })
}

function regenerateStatusPage(app: TestApp, cookies: Cookies, projectId: string) {
  return app.inject({
    method: 'POST',
    url: regenerateUrl(projectId),
    headers: { cookie: cookieHeader(cookies) },
  })
}

function publicStatusPage(app: TestApp, token: string) {
  return app.inject({ method: 'GET', url: `/api/v1/status-pages/${token}` })
}

/**
 * registerAndLoginViaApi grants a fresh owner an MFA grace period — expire it directly to
 * exercise the enforced branch of requireMfaEnrollment(), mirroring the identical pattern already
 * used by projects-archival.routes.test.ts / rotation/routes.test.ts for this exact scenario.
 */
async function expireMfaGracePeriod(orgId: string, userId: string): Promise<void> {
  await withOrg(orgId, (tx) =>
    tx
      .update(orgMemberships)
      .set({ gracePeriodExpiresAt: new Date(Date.now() - 1000) })
      .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)))
  )
}

describe.sequential('status page admin routes (Story 6.3, Sections C-G, J)', () => {
  let app: TestApp
  const { registerOwner, addUserToOrg, addProjectMember } = createMembershipTestHelpers({
    emailPrefix: 'status-page',
    orgNamePrefix: 'StatusPage',
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

  describe('POST /:projectId/status-page (enable, AC 8-10, 10a)', () => {
    it('creates a status page and returns a one-time plaintext token (happy path)', async () => {
      const owner = await registerOwner(app, 'enable-happy')
      const projectId = await createProjectViaApi(app, owner.cookies, 'sp-enable-happy')

      const res = await enableStatusPage(app, owner.cookies, projectId)
      expect(res.statusCode).toBe(201)
      const body = res.json<{ data: { token: string; createdAt: string } }>()
      expect(body.data.token.length).toBeGreaterThan(32)
      expect(new Date(body.data.createdAt).toISOString()).toBe(body.data.createdAt)
    })

    it('rejects a project member (non-owner) with 403 insufficient_role', async () => {
      const owner = await registerOwner(app, 'enable-forbidden')
      const projectId = await createProjectViaApi(app, owner.cookies, 'sp-enable-forbidden')
      const member = await addUserToOrg(app, owner.orgId, 'enable-forbidden-member')
      await addProjectMember(owner.orgId, projectId, member.userId, 'admin')

      const res = await enableStatusPage(app, member.cookies, projectId)
      expect(res.statusCode).toBe(403)
      expect(res.json()).toMatchObject({ code: 'insufficient_role' })
    })

    it('returns 404 project_not_found for a cross-org project', async () => {
      const owner = await registerOwner(app, 'enable-cross-org')
      const other = await registerOwner(app, 'enable-cross-org-other')
      const otherProjectId = await createProjectViaApi(app, other.cookies, 'sp-enable-cross-org')

      const res = await enableStatusPage(app, owner.cookies, otherProjectId)
      expect(res.statusCode).toBe(404)
      expect(res.json()).toMatchObject({ code: 'project_not_found' })
    })

    it('returns 410 for an archived project', async () => {
      const owner = await registerOwner(app, 'enable-archived')
      const projectId = await createProjectViaApi(app, owner.cookies, 'sp-enable-archived')
      const archiveRes = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${projectId}/archive`,
        headers: { cookie: cookieHeader(owner.cookies) },
      })
      expect(archiveRes.statusCode).toBe(200)

      const res = await enableStatusPage(app, owner.cookies, projectId)
      expect(res.statusCode).toBe(410)
    })

    it('returns 409 status_page_already_enabled on a second enable', async () => {
      const owner = await registerOwner(app, 'enable-conflict')
      const projectId = await createProjectViaApi(app, owner.cookies, 'sp-enable-conflict')

      expect((await enableStatusPage(app, owner.cookies, projectId)).statusCode).toBe(201)
      const second = await enableStatusPage(app, owner.cookies, projectId)
      expect(second.statusCode).toBe(409)
      expect(second.json()).toMatchObject({ code: 'status_page_already_enabled' })
    })

    it('requires MFA enrollment — an unenrolled owner gets 403 mfa_required', async () => {
      const unenrolled = await registerAndLoginViaApi(app, {
        email: `sp-mfa-${crypto.randomUUID()}@example.com`,
        password: 'correct-horse-battery-staple',
        orgName: `StatusPage MFA ${crypto.randomUUID()}`,
      })
      const projectId = await createProjectViaApi(app, unenrolled.cookies, 'sp-enable-mfa')
      await expireMfaGracePeriod(unenrolled.orgId, unenrolled.userId)

      const res = await enableStatusPage(app, unenrolled.cookies, projectId)
      expect(res.statusCode).toBe(403)
      expect(res.json()).toMatchObject({ code: 'mfa_required' })
    })

    it('rolls back the whole mutation when the audit write fails (AC 17)', async () => {
      const owner = await registerOwner(app, 'enable-audit-fail')
      const projectId = await createProjectViaApi(app, owner.cookies, 'sp-enable-audit-fail')

      const auditSpy = vi
        .spyOn(humanAudit, 'writeHumanAuditEntry')
        .mockRejectedValueOnce(new Error('forced audit failure'))
      try {
        const res = await enableStatusPage(app, owner.cookies, projectId)
        expectAuditWriteFailed(res)

        const rows = await withOrg(owner.orgId, (tx) =>
          tx.select().from(statusPages).where(eq(statusPages.projectId, projectId))
        )
        expect(rows).toHaveLength(0)
      } finally {
        auditSpy.mockRestore()
      }
    })

    it('writes a status_page.enabled audit row on success (AC 17)', async () => {
      const owner = await registerOwner(app, 'enable-audit-ok')
      const projectId = await createProjectViaApi(app, owner.cookies, 'sp-enable-audit-ok')

      await enableStatusPage(app, owner.cookies, projectId)

      const rows = await withOrg(owner.orgId, (tx) =>
        tx
          .select({ payload: auditLogEntries.payload })
          .from(auditLogEntries)
          .where(eq(auditLogEntries.eventType, 'status_page.enabled'))
      )
      expect(
        rows.some((r) => (r.payload as Record<string, unknown>)['projectId'] === projectId)
      ).toBe(true)
    })

    it('mutation rate limit returns 429 on the 61st request within 60s (AC 10a)', async () => {
      process.env['RATE_LIMIT_TEST_BYPASS'] = 'false'
      try {
        const owner = await registerOwner(app, 'enable-rate-limit')
        const projectId = await createProjectViaApi(app, owner.cookies, 'sp-rate-limit')
        // The rate-limit bucket is per-route-pattern, not per-outcome — the first POST 201s and
        // the rest 409 (already enabled), but all 61 count against the same WRITE_RATE_LIMIT key.
        let last: Awaited<ReturnType<typeof enableStatusPage>> | undefined
        for (let i = 0; i < 61; i += 1) {
          last = await enableStatusPage(app, owner.cookies, projectId)
        }
        expect(last?.statusCode).toBe(429)
      } finally {
        delete process.env['RATE_LIMIT_TEST_BYPASS']
      }
    }, 30_000)
  })

  describe('POST /:projectId/status-page/regenerate (AC 11)', () => {
    it('rotates the token so the old one 404s and the new one resolves', async () => {
      const owner = await registerOwner(app, 'regen-happy')
      const projectId = await createProjectViaApi(app, owner.cookies, 'sp-regen-happy')
      const enableRes = await enableStatusPage(app, owner.cookies, projectId)
      const oldToken = enableRes.json<{ data: { token: string } }>().data.token

      const regenRes = await regenerateStatusPage(app, owner.cookies, projectId)
      expect(regenRes.statusCode).toBe(200)
      const newToken = regenRes.json<{ data: { token: string } }>().data.token
      expect(newToken).not.toBe(oldToken)

      expect((await publicStatusPage(app, oldToken)).statusCode).toBe(404)
      expect((await publicStatusPage(app, newToken)).statusCode).toBe(200)
    })

    it('returns 404 status_page_not_found when no status page exists yet', async () => {
      const owner = await registerOwner(app, 'regen-missing')
      const projectId = await createProjectViaApi(app, owner.cookies, 'sp-regen-missing')

      const res = await regenerateStatusPage(app, owner.cookies, projectId)
      expect(res.statusCode).toBe(404)
      expect(res.json()).toMatchObject({ code: 'status_page_not_found' })
    })
  })

  describe('PUT /:projectId/status-page (update, AC 15)', () => {
    it('replaces the configured services (happy path)', async () => {
      const owner = await registerOwner(app, 'put-happy')
      const projectId = await createProjectViaApi(app, owner.cookies, 'sp-put-happy')
      const svcA = await insertEndpoint(owner.orgId, projectId, 'svc-a')
      const svcB = await insertEndpoint(owner.orgId, projectId, 'svc-b')
      await enableStatusPage(app, owner.cookies, projectId)

      const res = await putStatusPage(app, owner.cookies, projectId, [
        { serviceId: svcA, displayName: PAYMENTS_API_DISPLAY_NAME },
        { serviceId: svcB, displayName: 'Auth Service' },
      ])
      expect(res.statusCode).toBe(200)
      const body = res.json<{ data: { services: { serviceId: string; sortOrder: number }[] } }>()
      expect(body.data.services.map((s) => s.serviceId)).toEqual([svcA, svcB])
      expect(body.data.services.map((s) => s.sortOrder)).toEqual([0, 1])
    })

    it('clears all services with an empty array (edge)', async () => {
      const owner = await registerOwner(app, 'put-empty')
      const projectId = await createProjectViaApi(app, owner.cookies, 'sp-put-empty')
      const svcA = await insertEndpoint(owner.orgId, projectId, 'svc-empty')
      await enableStatusPage(app, owner.cookies, projectId)
      await putStatusPage(app, owner.cookies, projectId, [{ serviceId: svcA, displayName: 'X' }])

      const res = await putStatusPage(app, owner.cookies, projectId, [])
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ data: { services: [] } })
    })

    it('rejects a whitespace-only displayName with 422', async () => {
      const owner = await registerOwner(app, 'put-whitespace')
      const projectId = await createProjectViaApi(app, owner.cookies, 'sp-put-whitespace')
      const svcA = await insertEndpoint(owner.orgId, projectId, 'svc-ws')
      await enableStatusPage(app, owner.cookies, projectId)

      const res = await putStatusPage(app, owner.cookies, projectId, [
        { serviceId: svcA, displayName: '   ' },
      ])
      expect(res.statusCode).toBe(422)
    })

    it('rejects a serviceId from a different project with 422 invalid_service_reference', async () => {
      const owner = await registerOwner(app, 'put-cross-project')
      const projectId = await createProjectViaApi(app, owner.cookies, 'sp-put-cross-project')
      const otherProjectId = await createProjectViaApi(app, owner.cookies, 'sp-put-cross-project-2')
      const otherSvc = await insertEndpoint(owner.orgId, otherProjectId, 'svc-other-project')
      await enableStatusPage(app, owner.cookies, projectId)

      const res = await putStatusPage(app, owner.cookies, projectId, [
        { serviceId: otherSvc, displayName: 'Ghost' },
      ])
      expect(res.statusCode).toBe(422)
      expect(res.json()).toMatchObject({ code: 'invalid_service_reference' })
    })

    it('rejects a non-owner project member even though the route security floor is member', async () => {
      const owner = await registerOwner(app, 'put-member-forbidden')
      const projectId = await createProjectViaApi(app, owner.cookies, 'sp-put-member-forbidden')
      const svc = await insertEndpoint(owner.orgId, projectId, 'svc-member-forbidden')
      await enableStatusPage(app, owner.cookies, projectId)
      const member = await addUserToOrg(app, owner.orgId, 'put-member-forbidden-user')
      await addProjectMember(owner.orgId, projectId, member.userId, 'admin')

      const res = await putStatusPage(app, member.cookies, projectId, [
        { serviceId: svc, displayName: 'Not allowed' },
      ])

      expect(res.statusCode).toBe(403)
      expect(res.json()).toMatchObject({ code: 'insufficient_role' })
    })

    it('rejects a project A owner from reordering project B services in the same org', async () => {
      const orgOwner = await registerOwner(app, 'put-cross-project-org-owner')
      const ownerA = await addUserToOrg(app, orgOwner.orgId, 'put-cross-project-owner-a')
      const ownerB = await addUserToOrg(app, orgOwner.orgId, 'put-cross-project-owner-b')
      const projectA = await createProjectViaApi(app, ownerA.cookies, 'sp-put-project-a')
      const projectB = await createProjectViaApi(app, ownerB.cookies, 'sp-put-project-b')
      const svcB = await insertEndpoint(orgOwner.orgId, projectB, 'svc-project-b')
      await enableStatusPage(app, ownerB.cookies, projectB)

      const res = await putStatusPage(app, ownerA.cookies, projectB, [
        { serviceId: svcB, displayName: 'Cross-project write' },
      ])

      expect(projectA).not.toBe(projectB)
      expect(res.statusCode).toBe(403)
      expect(res.json()).toMatchObject({ code: 'insufficient_role' })
    })

    it('rejects a project A owner from reordering project B services across tenants', async () => {
      const ownerA = await registerOwner(app, 'put-cross-tenant-owner-a')
      const ownerB = await registerOwner(app, 'put-cross-tenant-owner-b')
      const projectA = await createProjectViaApi(app, ownerA.cookies, 'sp-put-cross-tenant-a')
      const projectB = await createProjectViaApi(app, ownerB.cookies, 'sp-put-cross-tenant-b')
      const svcB = await insertEndpoint(ownerB.orgId, projectB, 'svc-cross-tenant-b')
      await enableStatusPage(app, ownerB.cookies, projectB)

      const res = await putStatusPage(app, ownerA.cookies, projectB, [
        { serviceId: svcB, displayName: 'Cross-tenant write' },
      ])

      expect(projectA).not.toBe(projectB)
      expect(ownerA.orgId).not.toBe(ownerB.orgId)
      expect(res.statusCode).toBe(404)
      expect(res.json()).toMatchObject({ code: 'project_not_found' })
    })

    it('resolves a concurrent stale reorder versus service add with last-write-wins', async () => {
      const owner = await registerOwner(app, 'put-stale-add')
      const projectId = await createProjectViaApi(app, owner.cookies, 'sp-put-stale-add')
      const svcA = await insertEndpoint(owner.orgId, projectId, 'svc-stale-a')
      const svcB = await insertEndpoint(owner.orgId, projectId, 'svc-stale-b')
      const staleDisplayName = 'A reordered'
      await enableStatusPage(app, owner.cookies, projectId)
      await putStatusPage(app, owner.cookies, projectId, [{ serviceId: svcA, displayName: 'A' }])

      // Both submissions use valid snapshots from the same project. The existing full-replace
      // contract intentionally lets whichever transaction commits last win, so the final state
      // must be one complete submitted array rather than a partial or mixed list.
      const [staleReorder, addService] = await Promise.all([
        putStatusPage(app, owner.cookies, projectId, [
          { serviceId: svcA, displayName: staleDisplayName },
        ]),
        putStatusPage(app, owner.cookies, projectId, [
          { serviceId: svcA, displayName: 'A' },
          { serviceId: svcB, displayName: 'B' },
        ]),
      ])

      expect(staleReorder.statusCode).toBe(200)
      expect(addService.statusCode).toBe(200)
      const config = await getStatusPage(app, owner.cookies, projectId)
      expect(config.json()).toMatchObject({ data: { services: expect.any(Array) } })
      const finalServices = config.json<{
        data: { services: { serviceId: string; displayName: string; sortOrder: number }[] }
      }>().data.services
      expect([
        [{ serviceId: svcA, displayName: staleDisplayName, sortOrder: 0 }],
        [
          { serviceId: svcA, displayName: 'A', sortOrder: 0 },
          { serviceId: svcB, displayName: 'B', sortOrder: 1 },
        ],
      ]).toContainEqual(
        finalServices.map(({ serviceId, displayName, sortOrder }) => ({
          serviceId,
          displayName,
          sortOrder,
        }))
      )
    })

    it('rejects a duplicate serviceId in the same request with 422', async () => {
      const owner = await registerOwner(app, 'put-duplicate')
      const projectId = await createProjectViaApi(app, owner.cookies, 'sp-put-duplicate')
      const svcA = await insertEndpoint(owner.orgId, projectId, 'svc-dup')
      await enableStatusPage(app, owner.cookies, projectId)

      const res = await putStatusPage(app, owner.cookies, projectId, [
        { serviceId: svcA, displayName: 'First' },
        { serviceId: svcA, displayName: 'Second' },
      ])
      expect(res.statusCode).toBe(422)
    })

    it('rejects more than 50 services with 422', async () => {
      const owner = await registerOwner(app, 'put-cap')
      const projectId = await createProjectViaApi(app, owner.cookies, 'sp-put-cap')
      await enableStatusPage(app, owner.cookies, projectId)
      const services = Array.from({ length: 51 }, () => ({
        serviceId: crypto.randomUUID(),
        displayName: 'X',
      }))

      const res = await putStatusPage(app, owner.cookies, projectId, services)
      expect(res.statusCode).toBe(422)
    })

    it('returns 404 status_page_not_found when no status page exists yet', async () => {
      const owner = await registerOwner(app, 'put-missing')
      const projectId = await createProjectViaApi(app, owner.cookies, 'sp-put-missing')
      const svcA = await insertEndpoint(owner.orgId, projectId, 'svc-missing')

      const res = await putStatusPage(app, owner.cookies, projectId, [
        { serviceId: svcA, displayName: 'X' },
      ])
      expect(res.statusCode).toBe(404)
    })

    it('stores an HTML-shaped displayName verbatim (AC 15 injection example)', async () => {
      const owner = await registerOwner(app, 'put-injection')
      const projectId = await createProjectViaApi(app, owner.cookies, 'sp-put-injection')
      const svcA = await insertEndpoint(owner.orgId, projectId, 'svc-injection')
      await enableStatusPage(app, owner.cookies, projectId)
      const injected = '<script>alert(1)</script>&amp;'

      const res = await putStatusPage(app, owner.cookies, projectId, [
        { serviceId: svcA, displayName: injected },
      ])
      expect(res.statusCode).toBe(200)
      expect(
        res.json<{ data: { services: { displayName: string }[] } }>().data.services[0]?.displayName
      ).toBe(injected)
    })

    it('requires MFA enrollment', async () => {
      const unenrolled = await registerAndLoginViaApi(app, {
        email: `sp-put-mfa-${crypto.randomUUID()}@example.com`,
        password: 'correct-horse-battery-staple',
        orgName: `StatusPage PUT MFA ${crypto.randomUUID()}`,
      })
      const projectId = await createProjectViaApi(app, unenrolled.cookies, 'sp-put-mfa')
      await expireMfaGracePeriod(unenrolled.orgId, unenrolled.userId)

      const res = await putStatusPage(app, unenrolled.cookies, projectId, [])
      expect(res.statusCode).toBe(403)
      expect(res.json()).toMatchObject({ code: 'mfa_required' })
    })

    it('audit payload includes a previous-state snapshot (AC 17)', async () => {
      const owner = await registerOwner(app, 'put-audit-snapshot')
      const projectId = await createProjectViaApi(app, owner.cookies, 'sp-put-audit-snapshot')
      const svcA = await insertEndpoint(owner.orgId, projectId, 'svc-snap-a')
      const svcB = await insertEndpoint(owner.orgId, projectId, 'svc-snap-b')
      await enableStatusPage(app, owner.cookies, projectId)
      await putStatusPage(app, owner.cookies, projectId, [
        { serviceId: svcA, displayName: 'Old name' },
      ])

      await putStatusPage(app, owner.cookies, projectId, [
        { serviceId: svcB, displayName: 'New name' },
      ])

      const rows = await withOrg(owner.orgId, (tx) =>
        tx
          .select({ payload: auditLogEntries.payload })
          .from(auditLogEntries)
          .where(eq(auditLogEntries.eventType, 'status_page.updated'))
      )
      const match = rows.find((r) =>
        (
          (r.payload as Record<string, unknown>)['newDisplayNames'] as string[] | undefined
        )?.includes('New name')
      )?.payload as Record<string, unknown> | undefined
      expect(match).toMatchObject({
        previousServiceCount: 1,
        previousDisplayNames: ['Old name'],
        newServiceCount: 1,
        newDisplayNames: ['New name'],
      })
    })
  })

  describe('DELETE /:projectId/status-page (disable, AC 16)', () => {
    it('hard-deletes the status page and invalidates its public URL (happy path)', async () => {
      const owner = await registerOwner(app, 'delete-happy')
      const projectId = await createProjectViaApi(app, owner.cookies, 'sp-delete-happy')
      const enableRes = await enableStatusPage(app, owner.cookies, projectId)
      const token = enableRes.json<{ data: { token: string } }>().data.token

      const res = await deleteStatusPage(app, owner.cookies, projectId)
      expect(res.statusCode).toBe(204)
      expect((await publicStatusPage(app, token)).statusCode).toBe(404)
    })

    it('returns 404 (not idempotent) when no status page exists', async () => {
      const owner = await registerOwner(app, 'delete-missing')
      const projectId = await createProjectViaApi(app, owner.cookies, 'sp-delete-missing')

      const res = await deleteStatusPage(app, owner.cookies, projectId)
      expect(res.statusCode).toBe(404)
      expect(res.json()).toMatchObject({ code: 'status_page_not_found' })
    })
  })

  describe('GET /:projectId/status-page (get-config, AC 21)', () => {
    it('returns { enabled: false } when no status page exists yet (not 404)', async () => {
      const owner = await registerOwner(app, 'get-config-not-enabled')
      const projectId = await createProjectViaApi(app, owner.cookies, 'sp-get-config-not-enabled')

      const res = await getStatusPage(app, owner.cookies, projectId)
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ data: { enabled: false } })
    })

    it('returns the current configuration once enabled with services', async () => {
      const owner = await registerOwner(app, 'get-config-enabled')
      const projectId = await createProjectViaApi(app, owner.cookies, 'sp-get-config-enabled')
      const svcA = await insertEndpoint(owner.orgId, projectId, 'svc-config')
      await enableStatusPage(app, owner.cookies, projectId)
      await putStatusPage(app, owner.cookies, projectId, [
        { serviceId: svcA, displayName: PAYMENTS_API_DISPLAY_NAME },
      ])

      const res = await getStatusPage(app, owner.cookies, projectId)
      expect(res.statusCode).toBe(200)
      const body = res.json<{
        data: { enabled: boolean; services: { serviceId: string; displayName: string }[] }
      }>()
      expect(body.data.enabled).toBe(true)
      expect(body.data.services).toEqual([
        { serviceId: svcA, displayName: PAYMENTS_API_DISPLAY_NAME, sortOrder: 0 },
      ])
    })

    it('returns the same token as GET after enable, without regenerating (Story 21.7 HAPPY_PATH_NEW)', async () => {
      const owner = await registerOwner(app, 'get-config-token')
      const projectId = await createProjectViaApi(app, owner.cookies, 'sp-get-config-token')

      const enableRes = await enableStatusPage(app, owner.cookies, projectId)
      const issuedToken = enableRes.json<{ data: { token: string } }>().data.token

      const res = await getStatusPage(app, owner.cookies, projectId)
      expect(res.statusCode).toBe(200)
      expect(res.json<{ data: { token?: string } }>().data.token).toBe(issuedToken)
    })

    it('returns 403 for a non-owner project member', async () => {
      const owner = await registerOwner(app, 'get-config-forbidden')
      const projectId = await createProjectViaApi(app, owner.cookies, 'sp-get-config-forbidden')
      const member = await addUserToOrg(app, owner.orgId, 'get-config-forbidden-member')
      await addProjectMember(owner.orgId, projectId, member.userId, 'viewer')

      const res = await getStatusPage(app, member.cookies, projectId)
      expect(res.statusCode).toBe(403)
    })

    it('returns 404/410 for cross-org/archived projects, matching AC 8 conventions', async () => {
      const owner = await registerOwner(app, 'get-config-cross-org')
      const other = await registerOwner(app, 'get-config-cross-org-other')
      const otherProjectId = await createProjectViaApi(
        app,
        other.cookies,
        'sp-get-config-cross-org'
      )
      expect((await getStatusPage(app, owner.cookies, otherProjectId)).statusCode).toBe(404)

      const archivedProjectId = await createProjectViaApi(
        app,
        owner.cookies,
        'sp-get-config-archived'
      )
      await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${archivedProjectId}/archive`,
        headers: { cookie: cookieHeader(owner.cookies) },
      })
      expect((await getStatusPage(app, owner.cookies, archivedProjectId)).statusCode).toBe(410)
    })

    it('rate limit returns 429 on the 121st request within 60s (LIST_RATE_LIMIT)', async () => {
      process.env['RATE_LIMIT_TEST_BYPASS'] = 'false'
      try {
        const owner = await registerOwner(app, 'get-config-rate-limit')
        const projectId = await createProjectViaApi(app, owner.cookies, 'sp-get-config-rate-limit')
        let last: Awaited<ReturnType<typeof getStatusPage>> | undefined
        for (let i = 0; i < 121; i += 1) {
          last = await getStatusPage(app, owner.cookies, projectId)
        }
        expect(last?.statusCode).toBe(429)
      } finally {
        delete process.env['RATE_LIMIT_TEST_BYPASS']
      }
    }, 30_000)
  })

  describe('ownership authorization (ADR-6.3-07)', () => {
    it('allows an org owner who is not a project member (org-owner override path)', async () => {
      const owner = await registerOwner(app, 'org-owner-path')
      const projectId = await createProjectViaApi(app, owner.cookies, 'sp-org-owner-path')
      const orgOwner = await addUserToOrg(app, owner.orgId, 'org-owner-path-second', {
        orgRole: 'owner',
      })

      const res = await enableStatusPage(app, orgOwner.cookies, projectId)
      expect(res.statusCode).toBe(201)
    })
  })

  describe('public/private boundary (Story 21.7)', () => {
    it('never exposes encryptedToken, tokenHash, or token on the public (unauthenticated) status route', async () => {
      const owner = await registerOwner(app, 'public-boundary')
      const projectId = await createProjectViaApi(app, owner.cookies, 'sp-public-boundary')
      const svc = await insertEndpoint(owner.orgId, projectId, 'svc-public-boundary')
      const enableRes = await enableStatusPage(app, owner.cookies, projectId)
      const token = enableRes.json<{ data: { token: string } }>().data.token
      await putStatusPage(app, owner.cookies, projectId, [
        { serviceId: svc, displayName: PAYMENTS_API_DISPLAY_NAME },
      ])

      const res = await publicStatusPage(app, token)
      expect(res.statusCode).toBe(200)
      const raw = JSON.stringify(res.json())
      expect(raw).not.toContain('encryptedToken')
      expect(raw).not.toContain('tokenHash')
      expect(raw).not.toContain('"token"')
      expect(raw).not.toContain(token)
    })
  })

  describe('RLS cross-org isolation (AC 10)', () => {
    it("never exposes org A's status page config to org B", async () => {
      const orgA = await registerOwner(app, 'rls-a')
      const orgB = await registerOwner(app, 'rls-b')
      const projectId = await createProjectViaApi(app, orgA.cookies, 'sp-rls-a')
      await enableStatusPage(app, orgA.cookies, projectId)

      const rows = await withOrg(orgB.orgId, (tx) =>
        tx.select().from(statusPages).where(eq(statusPages.projectId, projectId))
      )
      expect(rows).toHaveLength(0)
    })
  })
})
