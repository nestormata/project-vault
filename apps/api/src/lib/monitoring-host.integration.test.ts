import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { getDb, withOrg } from '@project-vault/db'
import {
  monitoringAlerts,
  organizations,
  serviceEndpoints,
  statusPages,
} from '@project-vault/db/schema'
import { createTestUser, deleteTestUser, insertTestProject } from '@project-vault/db/test-helpers'
import type { ExtensionManifest } from '@project-vault/extension-api'
import {
  MonitoringOrgMismatchError,
  MonitoringResourceNotFoundError,
} from '@project-vault/extension-api'
import {
  configureAuthIntegrationEnv,
  initVaultForTest,
} from '../__tests__/helpers/auth-test-helpers.js'
import { resetVaultForTest } from '../__tests__/helpers/vault-test-cleanup.js'
import { StatusPageNotFoundError } from '../modules/monitoring/status-page-service.js'
import { __resetMonitoringHostRateLimitForTests, buildMonitoringHost } from './monitoring-host.js'
import { runWithRequestContext } from './request-context.js'

configureAuthIntegrationEnv()

const { initVault } = await import('../modules/vault/key-service.js')

const TEST_PASSPHRASE = 'monitoring-host-integration-tests-passphrase'

const MANIFEST: ExtensionManifest = {
  name: 'com.acme.monitoring-integration-fixture',
  apiVersion: '3.12.0',
  capabilities: [],
}

async function createTestOrg(label: string): Promise<string> {
  const orgName = `MonitoringHost ${label} ${randomUUID()}`
  const [org] = await getDb()
    .insert(organizations)
    .values({ name: orgName, slug: orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-') })
    .returning({ id: organizations.id })
  if (!org) throw new Error('createTestOrg: org insert returned no row')
  return org.id
}

/** Committed insert (its own transaction) of one service_endpoints row, so it is visible to a
 * LATER, separately-opened `withOrg()` transaction — mirrors `insertTestProject`'s own committed
 * pattern, required here because `buildMonitoringHost`'s methods each open their own transaction
 * rather than accepting a caller-supplied `tx`. */
async function insertTestServiceEndpoint(
  orgId: string,
  projectId: string,
  overrides: Partial<typeof serviceEndpoints.$inferInsert> = {}
): Promise<typeof serviceEndpoints.$inferSelect> {
  const [row] = await withOrg(orgId, (tx) =>
    tx
      .insert(serviceEndpoints)
      .values({
        orgId,
        projectId,
        name: `svc-${randomUUID().slice(0, 8)}`,
        url: `https://${randomUUID().slice(0, 8)}.example.com/health`,
        ...overrides,
      })
      .returning()
  )
  if (!row) throw new Error('insertTestServiceEndpoint: insert returned no row')
  return row
}

function bindAndRun<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  return runWithRequestContext({ orgId, userId: randomUUID() }, fn)
}

describe.sequential(
  'buildMonitoringHost — Story 34.1 real-Postgres/RLS integration (AC2, AC3, AC7)',
  () => {
    const host = buildMonitoringHost(MANIFEST)

    beforeAll(async () => {
      await resetVaultForTest()
      await initVaultForTest(initVault, TEST_PASSPHRASE)
    })

    afterAll(async () => {
      await resetVaultForTest()
    })

    afterEach(() => {
      __resetMonitoringHostRateLimitForTests()
    })

    describe('AC2 tenant isolation — the six in-request methods, ambient org A vs. a real org B resource', () => {
      it('deleteServiceEndpoint: a real org-B endpoint id/projectId pair resolves to null under org-A ambient context, and org B row is untouched', async () => {
        const orgA = await createTestOrg('delete-a')
        const orgB = await createTestOrg('delete-b')
        const userId = await createTestUser('monitoring-host-delete')
        try {
          const projectB = await insertTestProject(orgB, { userId, slug: 'delete-b-project' })
          const endpointB = await insertTestServiceEndpoint(orgB, projectB.id)

          const result = await bindAndRun(orgA, () =>
            host.deleteServiceEndpoint({
              serviceEndpointId: endpointB.id,
              projectId: projectB.id,
            })
          )
          expect(result).toBeNull()

          const stillThere = await withOrg(orgB, (tx) =>
            tx.select().from(serviceEndpoints).where(eq(serviceEndpoints.id, endpointB.id))
          )
          expect(stillThere).toHaveLength(1)
        } finally {
          await deleteTestUser(userId)
        }
      })

      it('updateServiceEndpointPauseState: a real org-B endpoint id/projectId pair resolves to null under org-A ambient context, and org B row is not paused', async () => {
        const orgA = await createTestOrg('pause-a')
        const orgB = await createTestOrg('pause-b')
        const userId = await createTestUser('monitoring-host-pause')
        try {
          const projectB = await insertTestProject(orgB, { userId, slug: 'pause-b-project' })
          const endpointB = await insertTestServiceEndpoint(orgB, projectB.id)

          const result = await bindAndRun(orgA, () =>
            host.updateServiceEndpointPauseState({
              serviceEndpointId: endpointB.id,
              projectId: projectB.id,
              userId,
              paused: true,
            })
          )
          expect(result).toBeNull()

          const [row] = await withOrg(orgB, (tx) =>
            tx.select().from(serviceEndpoints).where(eq(serviceEndpoints.id, endpointB.id))
          )
          expect(row?.healthCheckPausedAt).toBeNull()
        } finally {
          await deleteTestUser(userId)
        }
      })

      it("getHealthDashboardData: org-A ambient context never sees org B's projects/services", async () => {
        const orgA = await createTestOrg('dash-a')
        const orgB = await createTestOrg('dash-b')
        const userId = await createTestUser('monitoring-host-dash')
        try {
          const projectB = await insertTestProject(orgB, { userId, slug: 'dash-b-project' })
          await insertTestServiceEndpoint(orgB, projectB.id, { status: 'down' })

          const dashboard = await bindAndRun(orgA, () => host.getHealthDashboardData())
          expect(dashboard).toEqual({ projects: [], summary: { healthy: 0, degraded: 0, down: 0 } })
        } finally {
          await deleteTestUser(userId)
        }
      })

      it("enableStatusPage: a real org-B projectId under org-A ambient context is rejected — never creates a cross-tenant status_pages row (regression for the fix this story's own integration testing found)", async () => {
        const orgA = await createTestOrg('enable-a')
        const orgB = await createTestOrg('enable-b')
        const userId = await createTestUser('monitoring-host-enable')
        try {
          const projectB = await insertTestProject(orgB, { userId, slug: 'enable-b-project' })

          await expect(
            bindAndRun(orgA, () => host.enableStatusPage({ projectId: projectB.id, userId }))
          ).rejects.toBeInstanceOf(MonitoringResourceNotFoundError)

          // Confirm from org B's own scoped view that no status page was ever created for its
          // project — proves the rejection happened BEFORE any insert, not merely that org A
          // can't read a row it wrote under the wrong org.
          const rows = await withOrg(orgB, (tx) =>
            tx.select().from(statusPages).where(eq(statusPages.projectId, projectB.id))
          )
          expect(rows).toHaveLength(0)
        } finally {
          await deleteTestUser(userId)
        }
      })

      it('enableStatusPage: the happy path still works when the projectId genuinely belongs to the ambient org', async () => {
        const orgA = await createTestOrg('enable-happy-a')
        const userId = await createTestUser('monitoring-host-enable-happy')
        try {
          const projectA = await insertTestProject(orgA, { userId, slug: 'enable-happy-project' })

          const result = await bindAndRun(orgA, () =>
            host.enableStatusPage({ projectId: projectA.id, userId })
          )
          expect(result.token).toEqual(expect.any(String))

          const rows = await withOrg(orgA, (tx) =>
            tx.select().from(statusPages).where(eq(statusPages.projectId, projectA.id))
          )
          expect(rows).toHaveLength(1)
        } finally {
          await deleteTestUser(userId)
        }
      })

      it("regenerateStatusPageToken: a real org-B project with its own enabled status page is invisible under org-A ambient context (protected by status_pages' own RLS, no code change needed)", async () => {
        const orgA = await createTestOrg('regen-a')
        const orgB = await createTestOrg('regen-b')
        const userId = await createTestUser('monitoring-host-regen')
        try {
          const projectB = await insertTestProject(orgB, { userId, slug: 'regen-b-project' })
          await bindAndRun(orgB, () => host.enableStatusPage({ projectId: projectB.id, userId }))

          await expect(
            bindAndRun(orgA, () => host.regenerateStatusPageToken({ projectId: projectB.id }))
          ).rejects.toBeInstanceOf(StatusPageNotFoundError)
        } finally {
          await deleteTestUser(userId)
        }
      })

      it("disableStatusPage: a real org-B project with its own enabled status page resolves to null under org-A ambient context, and org B's status page is untouched", async () => {
        const orgA = await createTestOrg('disable-a')
        const orgB = await createTestOrg('disable-b')
        const userId = await createTestUser('monitoring-host-disable')
        try {
          const projectB = await insertTestProject(orgB, { userId, slug: 'disable-b-project' })
          await bindAndRun(orgB, () => host.enableStatusPage({ projectId: projectB.id, userId }))

          const result = await bindAndRun(orgA, () =>
            host.disableStatusPage({ projectId: projectB.id })
          )
          expect(result).toBeNull()

          const rows = await withOrg(orgB, (tx) =>
            tx.select().from(statusPages).where(eq(statusPages.projectId, projectB.id))
          )
          expect(rows).toHaveLength(1)
        } finally {
          await deleteTestUser(userId)
        }
      })
    })

    describe('AC3 out-of-request explicit organizationId — real withOrg/RLS scoping', () => {
      it('applyHealthCheckResult: a genuinely non-existent organizationId (well-formed UUID, no such org) yields not-found, never a leak', async () => {
        const nonExistentOrgId = randomUUID()
        await expect(
          host.applyHealthCheckResult({
            organizationId: nonExistentOrgId,
            serviceEndpoint: { id: randomUUID(), orgId: nonExistentOrgId },
            isHealthy: true,
            statusCode: 200,
            latencyMs: 5,
            failureReason: null,
          })
        ).rejects.toBeInstanceOf(MonitoringResourceNotFoundError)
      })

      it('cleanupProjectMonitoring: a genuinely non-existent organizationId yields not-found, never a leak', async () => {
        const nonExistentOrgId = randomUUID()
        await expect(
          host.cleanupProjectMonitoring({
            organizationId: nonExistentOrgId,
            projectId: randomUUID(),
          })
        ).rejects.toBeInstanceOf(MonitoringResourceNotFoundError)
      })

      it('cleanupProjectMonitoring: a valid, real-but-legitimately-different organizationId/projectId pair is served scoped to THAT org — documented AC3 limitation, not a bug (RLS enforces "belongs to this org," not "caller is entitled to this org")', async () => {
        const orgB = await createTestOrg('real-but-wrong-b')
        const userId = await createTestUser('monitoring-host-real-wrong')
        try {
          const projectB = await insertTestProject(orgB, { userId, slug: 'real-wrong-project' })
          const endpointB = await insertTestServiceEndpoint(orgB, projectB.id)
          await withOrg(orgB, (tx) =>
            tx.insert(monitoringAlerts).values({
              orgId: orgB,
              projectId: projectB.id,
              serviceEndpointId: endpointB.id,
              alertType: 'service.down',
              severity: 'critical',
              episodeKey: 'episode-real-wrong',
              payload: {},
              status: 'active',
            })
          )

          // No ambient context / no caller-identity check exists on this out-of-request method —
          // any caller supplying orgB's own real id is served against orgB's real data, exactly
          // as AC3's edge case documents.
          const result = await host.cleanupProjectMonitoring({
            organizationId: orgB,
            projectId: projectB.id,
          })
          expect(result).toEqual({ resolvedAlertCount: 1 })
        } finally {
          await deleteTestUser(userId)
        }
      })
    })

    describe('AC7 — cross-tenant organizationId/resource mismatch rejections', () => {
      it('applyHealthCheckResult rejects when organizationId disagrees with the supplied serviceEndpoint.orgId, before any DB call', async () => {
        const orgA = await createTestOrg('mismatch-a')
        const orgB = await createTestOrg('mismatch-b')
        await expect(
          host.applyHealthCheckResult({
            organizationId: orgA,
            serviceEndpoint: { id: randomUUID(), orgId: orgB },
            isHealthy: true,
            statusCode: 200,
            latencyMs: 5,
            failureReason: null,
          })
        ).rejects.toBeInstanceOf(MonitoringOrgMismatchError)
      })

      it("applyHealthCheckResult rejects a smuggled orgId — organizationId matches the CLAIMED serviceEndpoint.orgId, but the endpoint's real, authoritative row belongs to a different org", async () => {
        const orgA = await createTestOrg('smuggle-a')
        const orgB = await createTestOrg('smuggle-b')
        const userId = await createTestUser('monitoring-host-smuggle')
        try {
          const projectB = await insertTestProject(orgB, { userId, slug: 'smuggle-b-project' })
          const endpointB = await insertTestServiceEndpoint(orgB, projectB.id)

          // The pre-check passes (orgA === claimed orgId), but the re-fetched authoritative row
          // (scoped to orgA via withOrg/RLS) can never resolve to org B's real endpoint.
          await expect(
            host.applyHealthCheckResult({
              organizationId: orgA,
              serviceEndpoint: { id: endpointB.id, orgId: orgA },
              isHealthy: true,
              statusCode: 200,
              latencyMs: 5,
              failureReason: null,
            })
          ).rejects.toBeInstanceOf(MonitoringResourceNotFoundError)

          const [row] = await withOrg(orgB, (tx) =>
            tx.select().from(serviceEndpoints).where(eq(serviceEndpoints.id, endpointB.id))
          )
          expect(row?.lastCheckedAt).toBeNull()
        } finally {
          await deleteTestUser(userId)
        }
      })

      it('applyHealthCheckResult happy path: a genuinely matching organizationId/serviceEndpoint.orgId/real row applies the health-check result', async () => {
        const orgA = await createTestOrg('happy-apply-a')
        const userId = await createTestUser('monitoring-host-happy-apply')
        try {
          const projectA = await insertTestProject(orgA, { userId, slug: 'happy-apply-project' })
          const endpointA = await insertTestServiceEndpoint(orgA, projectA.id)

          const result = await host.applyHealthCheckResult({
            organizationId: orgA,
            serviceEndpoint: { id: endpointA.id, orgId: orgA },
            isHealthy: true,
            statusCode: 200,
            latencyMs: 12,
            failureReason: null,
          })
          expect(result.updatedRow.id).toBe(endpointA.id)
          expect(result.updatedRow.lastCheckedAt).not.toBeNull()
        } finally {
          await deleteTestUser(userId)
        }
      })

      it('cleanupProjectMonitoring rejects when the supplied projectId does not actually belong to the supplied organizationId', async () => {
        const orgA = await createTestOrg('cleanup-mismatch-a')
        const orgB = await createTestOrg('cleanup-mismatch-b')
        const userId = await createTestUser('monitoring-host-cleanup-mismatch')
        try {
          const projectB = await insertTestProject(orgB, {
            userId,
            slug: 'cleanup-mismatch-project',
          })

          await expect(
            host.cleanupProjectMonitoring({ organizationId: orgA, projectId: projectB.id })
          ).rejects.toBeInstanceOf(MonitoringResourceNotFoundError)
        } finally {
          await deleteTestUser(userId)
        }
      })
    })

    describe('cleanupServiceEndpointsForProjectDeletion via the host wrapper — atomicity/idempotency (AC7)', () => {
      it('a second call against the same already-cleaned-up project is a no-op: resolvedAlertCount: 0, no duplicate side effects', async () => {
        const orgId = await createTestOrg('idempotent')
        const userId = await createTestUser('monitoring-host-idempotent')
        try {
          const project = await insertTestProject(orgId, { userId, slug: 'idempotent-project' })
          const endpoint = await insertTestServiceEndpoint(orgId, project.id)
          await withOrg(orgId, (tx) =>
            tx.insert(monitoringAlerts).values({
              orgId,
              projectId: project.id,
              serviceEndpointId: endpoint.id,
              alertType: 'service.down',
              severity: 'critical',
              episodeKey: 'episode-idempotent',
              payload: {},
              status: 'active',
            })
          )

          const first = await host.cleanupProjectMonitoring({
            organizationId: orgId,
            projectId: project.id,
          })
          expect(first).toEqual({ resolvedAlertCount: 1 })

          const second = await host.cleanupProjectMonitoring({
            organizationId: orgId,
            projectId: project.id,
          })
          expect(second).toEqual({ resolvedAlertCount: 0 })

          const alerts = await withOrg(orgId, (tx) =>
            tx
              .select()
              .from(monitoringAlerts)
              .where(
                and(
                  eq(monitoringAlerts.serviceEndpointId, endpoint.id),
                  eq(monitoringAlerts.status, 'resolved_by_deletion')
                )
              )
          )
          expect(alerts).toHaveLength(1)
        } finally {
          await deleteTestUser(userId)
        }
      })
    })
  }
)
