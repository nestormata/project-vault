import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { projects, serviceEndpoints } from '@project-vault/db/schema'
import {
  createTestUser,
  deleteTestUser,
  insertTestProject,
  withTestOrg,
} from '@project-vault/db/test-helpers'
import { getHealthDashboardData } from './health-dashboard-service.js'

describe('getHealthDashboardData (Story 6.3 ADR-6.3-02, realigned)', () => {
  it('groups service_endpoints by non-archived project using exactly one batched query, not per-project N+1', async () => {
    await withTestOrg(async ({ orgId, tx }) => {
      const userId = await createTestUser('health-dashboard')
      try {
        const projectA = await insertTestProject(orgId, { userId, slug: 'health-a' })
        const projectB = await insertTestProject(orgId, { userId, slug: 'health-b' })

        await tx.insert(serviceEndpoints).values([
          {
            orgId,
            projectId: projectA.id,
            name: 'healthy-svc',
            url: 'https://a.example.com/health',
            status: 'healthy',
          },
          {
            orgId,
            projectId: projectA.id,
            name: 'down-svc',
            url: 'https://a2.example.com/health',
            status: 'down',
            consecutiveFailures: 3,
          },
          {
            orgId,
            projectId: projectB.id,
            name: 'degraded-svc',
            url: 'https://b.example.com/health',
            status: 'degraded',
            consecutiveFailures: 1,
          },
        ])

        let selectCount = 0
        const countingTx = new Proxy(tx, {
          get(target, property, receiver) {
            if (property === 'select') selectCount += 1
            return Reflect.get(target, property, receiver)
          },
        })

        const result = await getHealthDashboardData(countingTx as typeof tx)

        // One select for non-archived projects, one batched select for service_endpoints across
        // every project id — never one select per project (ADR-6.3-02's N+1-avoidance rule).
        expect(selectCount).toBe(2)

        expect(result.summary).toEqual({ healthy: 1, degraded: 1, down: 1 })
        const byId = new Map(result.projects.map((p) => [p.projectId, p]))
        expect(byId.get(projectA.id)?.services).toHaveLength(2)
        expect(byId.get(projectB.id)?.services).toHaveLength(1)
        expect(byId.get(projectB.id)?.services[0]).toMatchObject({
          name: 'degraded-svc',
          status: 'degraded',
        })
      } finally {
        await deleteTestUser(userId)
      }
    })
  })

  it('excludes a project that only has payment_records-style rows (no service_endpoints at all)', async () => {
    await withTestOrg(async ({ orgId, tx }) => {
      const userId = await createTestUser('health-dashboard-nosvc')
      try {
        const withServices = await insertTestProject(orgId, { userId, slug: 'health-with-svc' })
        await insertTestProject(orgId, { userId, slug: 'health-without-svc' })

        await tx.insert(serviceEndpoints).values({
          orgId,
          projectId: withServices.id,
          name: 'svc',
          url: 'https://only.example.com/health',
          status: 'healthy',
        })

        const result = await getHealthDashboardData(tx)
        expect(result.projects).toHaveLength(1)
        expect(result.projects[0]?.projectId).toBe(withServices.id)
      } finally {
        await deleteTestUser(userId)
      }
    })
  })

  it('excludes an archived project even though its service_endpoints rows still physically exist', async () => {
    await withTestOrg(async ({ orgId, tx }) => {
      const userId = await createTestUser('health-dashboard-archived')
      try {
        const archived = await insertTestProject(orgId, { userId, slug: 'health-archived' })
        await tx.insert(serviceEndpoints).values({
          orgId,
          projectId: archived.id,
          name: 'svc',
          url: 'https://archived.example.com/health',
          status: 'healthy',
        })
        // Archives via its own committed transaction (mirroring insertTestProject's pattern) —
        // updating the row through the shared outer `tx` would leave an uncommitted new tuple
        // version referencing the test user, which then deadlocks the `finally` block's
        // deleteTestUser (its ON DELETE SET NULL cascade check blocks waiting on this same
        // transaction to resolve). READ COMMITTED still sees this committed update from the
        // outer tx's subsequent SELECT.
        await withOrg(orgId, (innerTx) =>
          innerTx
            .update(projects)
            .set({ archivedAt: new Date() })
            .where(eq(projects.id, archived.id))
        )

        const result = await getHealthDashboardData(tx)
        expect(result.projects.find((p) => p.projectId === archived.id)).toBeUndefined()
      } finally {
        await deleteTestUser(userId)
      }
    })
  })

  it('returns an empty projects list and a zeroed summary when no services exist anywhere in the org', async () => {
    await withTestOrg(async ({ tx }) => {
      const result = await getHealthDashboardData(tx)
      expect(result).toEqual({ projects: [], summary: { healthy: 0, degraded: 0, down: 0 } })
    })
  })

  it('reports a never-checked service verbatim as healthy with lastCheckedAt null (AC 2, ADR-6.3-03)', async () => {
    await withTestOrg(async ({ orgId, tx }) => {
      const userId = await createTestUser('health-dashboard-never-checked')
      try {
        const project = await insertTestProject(orgId, { userId, slug: 'health-never-checked' })
        await tx.insert(serviceEndpoints).values({
          orgId,
          projectId: project.id,
          name: 'fresh-svc',
          url: 'https://fresh.example.com/health',
        })

        const result = await getHealthDashboardData(tx)
        expect(result.projects[0]?.services[0]).toMatchObject({
          name: 'fresh-svc',
          status: 'healthy',
          lastCheckedAt: null,
        })
      } finally {
        await deleteTestUser(userId)
      }
    })
  })

  describe('permittedProjectIds filter (Story 34.1 AC5)', () => {
    it('filters the underlying query to only the permitted projects when supplied', async () => {
      await withTestOrg(async ({ orgId, tx }) => {
        const userId = await createTestUser('health-dashboard-filter')
        try {
          const projectA = await insertTestProject(orgId, { userId, slug: 'health-filter-a' })
          const projectB = await insertTestProject(orgId, { userId, slug: 'health-filter-b' })
          const projectC = await insertTestProject(orgId, { userId, slug: 'health-filter-c' })

          await tx.insert(serviceEndpoints).values([
            { orgId, projectId: projectA.id, name: 'svc-a', url: 'https://a.example.com/health' },
            { orgId, projectId: projectB.id, name: 'svc-b', url: 'https://b.example.com/health' },
            { orgId, projectId: projectC.id, name: 'svc-c', url: 'https://c.example.com/health' },
          ])

          const result = await getHealthDashboardData(tx, [projectA.id, projectB.id])
          const returnedIds = result.projects.map((p) => p.projectId).sort()
          expect(returnedIds).toEqual([projectA.id, projectB.id].sort())
        } finally {
          await deleteTestUser(userId)
        }
      })
    })

    it('treats an explicit empty array as "nothing permitted", not "unfiltered"', async () => {
      await withTestOrg(async ({ orgId, tx }) => {
        const userId = await createTestUser('health-dashboard-filter-empty')
        try {
          const project = await insertTestProject(orgId, { userId, slug: 'health-filter-empty' })
          await tx.insert(serviceEndpoints).values({
            orgId,
            projectId: project.id,
            name: 'svc',
            url: 'https://empty.example.com/health',
          })

          const result = await getHealthDashboardData(tx, [])
          expect(result).toEqual({ projects: [], summary: { healthy: 0, degraded: 0, down: 0 } })
        } finally {
          await deleteTestUser(userId)
        }
      })
    })

    it('silently drops a foreign/nonexistent project id from the filter rather than widening scope', async () => {
      await withTestOrg(async ({ orgId, tx }) => {
        const userId = await createTestUser('health-dashboard-filter-foreign')
        try {
          const project = await insertTestProject(orgId, { userId, slug: 'health-filter-foreign' })
          await tx.insert(serviceEndpoints).values({
            orgId,
            projectId: project.id,
            name: 'svc',
            url: 'https://foreign.example.com/health',
          })

          // eslint-disable-next-line no-secrets/no-secrets -- test fixture UUID, not a secret.
          const foreignId = '00000000-0000-0000-0000-000000000000'
          const result = await getHealthDashboardData(tx, [project.id, foreignId])
          expect(result.projects).toHaveLength(1)
          expect(result.projects[0]?.projectId).toBe(project.id)
        } finally {
          await deleteTestUser(userId)
        }
      })
    })

    it("omitting the parameter preserves today's existing all-projects-in-org behavior", async () => {
      await withTestOrg(async ({ orgId, tx }) => {
        const userId = await createTestUser('health-dashboard-filter-omit')
        try {
          const project = await insertTestProject(orgId, { userId, slug: 'health-filter-omit' })
          await tx.insert(serviceEndpoints).values({
            orgId,
            projectId: project.id,
            name: 'svc',
            url: 'https://omit.example.com/health',
          })

          const result = await getHealthDashboardData(tx, undefined)
          expect(result.projects.map((p) => p.projectId)).toContain(project.id)
        } finally {
          await deleteTestUser(userId)
        }
      })
    })
  })
})
