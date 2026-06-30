import { describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { notificationQueue, securityAlerts } from '@project-vault/db/schema'
import { withTestOrg } from '@project-vault/db/test-helpers'
import { createMockBoss } from '../__tests__/helpers/notification-test-helpers.js'
import { runNotificationBackfill } from './notification-backfill.js'
import type { FastifyBaseLogger } from 'fastify'

process.env['DATABASE_URL'] ??=
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'

const FAILED_AUTH_TEMPLATE = 'security.failed_auth_threshold'

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as FastifyBaseLogger

describe('notification backfill', () => {
  it('processes all PENDING_DELIVERY security alerts and marks them delivered', async () => {
    const { boss } = createMockBoss()
    await boss.start()

    await withTestOrg(async ({ orgId }) => {
      const alerts = await withOrg(orgId, async (tx) => {
        const first = await tx
          .insert(securityAlerts)
          .values({
            orgId,
            alertType: FAILED_AUTH_TEMPLATE,
            severity: 'critical',
            status: 'PENDING_DELIVERY',
            payload: { attemptCount: 10 },
          })
          .returning({ id: securityAlerts.id })
        const second = await tx
          .insert(securityAlerts)
          .values({
            orgId,
            alertType: FAILED_AUTH_TEMPLATE,
            severity: 'critical',
            status: 'PENDING_DELIVERY',
            payload: { attemptCount: 10 },
          })
          .returning({ id: securityAlerts.id })
        const alert1 = first[0]
        const alert2 = second[0]
        if (!alert1 || !alert2) throw new Error('expected alerts to be inserted')
        return [alert1, alert2]
      })

      const alert1 = alerts[0]
      const alert2 = alerts[1]
      if (!alert1 || !alert2) throw new Error('expected two alerts')

      await runNotificationBackfill(boss, testLogger)

      const updatedAlerts = await withOrg(orgId, (tx) => tx.select().from(securityAlerts))
      expect(updatedAlerts.every((alert) => alert.status === 'delivered')).toBe(true)
      expect(updatedAlerts.map((alert) => alert.id).sort()).toEqual([alert1.id, alert2.id].sort())

      const queueEntries = await withOrg(orgId, (tx) => tx.select().from(notificationQueue))
      expect(queueEntries.length).toBeGreaterThan(0)
    })
  })

  it('is idempotent — running twice does not double-enqueue', async () => {
    const { boss } = createMockBoss()
    await boss.start()

    await withTestOrg(async ({ orgId }) => {
      const alert = await withOrg(orgId, async (tx) => {
        const [row] = await tx
          .insert(securityAlerts)
          .values({
            orgId,
            alertType: FAILED_AUTH_TEMPLATE,
            severity: 'critical',
            status: 'PENDING_DELIVERY',
            payload: { attemptCount: 10 },
          })
          .returning({ id: securityAlerts.id })
        if (!row) throw new Error('expected alert to be inserted')
        return row
      })

      await runNotificationBackfill(boss, testLogger)
      await runNotificationBackfill(boss, testLogger)

      const [updatedAlert] = await withOrg(orgId, (tx) =>
        tx.select().from(securityAlerts).where(eq(securityAlerts.id, alert.id))
      )
      expect(updatedAlert?.status).toBe('delivered')

      const queueEntries = await withOrg(orgId, (tx) =>
        tx
          .select()
          .from(notificationQueue)
          .where(eq(notificationQueue.templateId, FAILED_AUTH_TEMPLATE))
      )
      expect(queueEntries).toHaveLength(1)
    })
  })
})
