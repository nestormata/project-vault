import { describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { monitoringAlerts, notificationQueue, serviceEndpoints } from '@project-vault/db/schema'
import {
  createTestUser,
  deleteTestUser,
  insertTestProject,
  withTestOrg,
} from '@project-vault/db/test-helpers'
import { cleanupServiceEndpointsForProjectDeletion } from './service.js'

const SERVICE_DOWN_ALERT_TYPE = 'service.down'

describe('cleanupServiceEndpointsForProjectDeletion (Story 34.1 Design Decision 6/AC7)', () => {
  it('resolves active/snoozed alerts and suppresses pending notifications for every endpoint in the project, atomically', async () => {
    await withTestOrg(async ({ orgId, tx }) => {
      const userId = await createTestUser('monitoring-cleanup')
      try {
        const project = await insertTestProject(orgId, { userId, slug: 'cleanup-happy' })

        const [endpointA] = await tx
          .insert(serviceEndpoints)
          .values({
            orgId,
            projectId: project.id,
            name: 'svc-a',
            url: 'https://a.example.com/health',
          })
          .returning()
        const [endpointB] = await tx
          .insert(serviceEndpoints)
          .values({
            orgId,
            projectId: project.id,
            name: 'svc-b',
            url: 'https://b.example.com/health',
          })
          .returning()
        const [endpointC] = await tx
          .insert(serviceEndpoints)
          .values({
            orgId,
            projectId: project.id,
            name: 'svc-c-no-alerts',
            url: 'https://c.example.com/health',
          })
          .returning()
        if (!endpointA || !endpointB || !endpointC) throw new Error('expected endpoints inserted')

        await tx.insert(monitoringAlerts).values([
          {
            orgId,
            projectId: project.id,
            serviceEndpointId: endpointA.id,
            alertType: SERVICE_DOWN_ALERT_TYPE,
            severity: 'critical',
            episodeKey: 'episode-a',
            payload: {},
            status: 'active',
          },
          {
            orgId,
            projectId: project.id,
            serviceEndpointId: endpointB.id,
            alertType: SERVICE_DOWN_ALERT_TYPE,
            severity: 'critical',
            episodeKey: 'episode-b',
            payload: {},
            status: 'snoozed',
          },
        ])

        await tx.insert(notificationQueue).values([
          {
            orgId,
            channel: 'email',
            templateId: 'monitoring.service_down',
            recipientEmail: 'ops@example.com',
            status: 'pending',
            payload: { serviceEndpointId: endpointA.id },
          },
          {
            orgId,
            channel: 'email',
            templateId: 'monitoring.service_down',
            recipientEmail: 'ops@example.com',
            status: 'pending',
            payload: { serviceEndpointId: endpointB.id },
          },
        ])

        const result = await cleanupServiceEndpointsForProjectDeletion(tx, {
          projectId: project.id,
          orgId,
        })

        expect(result).toEqual({ resolvedAlertCount: 2 })

        const alerts = await tx
          .select()
          .from(monitoringAlerts)
          .where(eq(monitoringAlerts.projectId, project.id))
        expect(alerts.every((alert) => alert.status === 'resolved_by_deletion')).toBe(true)

        const queued = await tx
          .select()
          .from(notificationQueue)
          .where(eq(notificationQueue.orgId, orgId))
        expect(queued.every((row) => row.status === 'suppressed')).toBe(true)

        // The service-endpoint rows themselves are untouched (Story 35-1's own concern).
        const endpoints = await tx
          .select()
          .from(serviceEndpoints)
          .where(eq(serviceEndpoints.projectId, project.id))
        expect(endpoints).toHaveLength(3)
      } finally {
        await deleteTestUser(userId)
      }
    })
  })

  it('is idempotent — re-running against an already-resolved project resolves zero additional alerts', async () => {
    await withTestOrg(async ({ orgId, tx }) => {
      const userId = await createTestUser('monitoring-cleanup-idempotent')
      try {
        const project = await insertTestProject(orgId, { userId, slug: 'cleanup-idempotent' })
        const [endpoint] = await tx
          .insert(serviceEndpoints)
          .values({
            orgId,
            projectId: project.id,
            name: 'svc',
            url: 'https://x.example.com/health',
          })
          .returning()
        if (!endpoint) throw new Error('expected endpoint inserted')

        await tx.insert(monitoringAlerts).values({
          orgId,
          projectId: project.id,
          serviceEndpointId: endpoint.id,
          alertType: SERVICE_DOWN_ALERT_TYPE,
          severity: 'critical',
          episodeKey: 'episode-x',
          payload: {},
          status: 'active',
        })

        const first = await cleanupServiceEndpointsForProjectDeletion(tx, {
          projectId: project.id,
          orgId,
        })
        expect(first).toEqual({ resolvedAlertCount: 1 })

        const second = await cleanupServiceEndpointsForProjectDeletion(tx, {
          projectId: project.id,
          orgId,
        })
        expect(second).toEqual({ resolvedAlertCount: 0 })

        const alerts = await tx
          .select()
          .from(monitoringAlerts)
          .where(
            and(
              eq(monitoringAlerts.serviceEndpointId, endpoint.id),
              eq(monitoringAlerts.status, 'resolved_by_deletion')
            )
          )
        expect(alerts).toHaveLength(1)
      } finally {
        await deleteTestUser(userId)
      }
    })
  })

  it('returns resolvedAlertCount: 0 for a project with no service endpoints at all', async () => {
    await withTestOrg(async ({ orgId, tx }) => {
      const userId = await createTestUser('monitoring-cleanup-empty')
      try {
        const project = await insertTestProject(orgId, { userId, slug: 'cleanup-empty' })
        const result = await cleanupServiceEndpointsForProjectDeletion(tx, {
          projectId: project.id,
          orgId,
        })
        expect(result).toEqual({ resolvedAlertCount: 0 })
      } finally {
        await deleteTestUser(userId)
      }
    })
  })
})
