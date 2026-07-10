import { afterEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { notificationQueue, orgMemberships, securityAlerts } from '@project-vault/db/schema'
import { withTestOrg, createTestUser, deleteTestUser } from '@project-vault/db/test-helpers'
import { createMockBoss } from '../__tests__/helpers/notification-test-helpers.js'
import { expectQueueStatus } from '../__tests__/helpers/notification-test-helpers.js'
import { runNotificationBackfill } from './notification-backfill.js'
import { deliverNotification } from './notification-deliver.js'
import { resetEmailTransportForTesting, setEmailTransportForTesting } from './notification-email.js'
import type { FastifyBaseLogger } from 'fastify'
import nodemailer from 'nodemailer'

process.env['DATABASE_URL'] ??=
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'

const FAILED_AUTH_TEMPLATE = 'security.failed_auth_threshold'
const FAILED_AUTH_PAYLOAD = {
  thresholdType: 'ip',
  thresholdCount: 10,
  windowSeconds: 300,
  attemptCount: 10,
  windowStart: new Date().toISOString(),
  windowEnd: new Date().toISOString(),
  ipAddress: '203.0.113.1',
}

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as FastifyBaseLogger

async function seedOwner(orgId: string, userId: string) {
  await withOrg(orgId, (tx) =>
    tx.insert(orgMemberships).values({ orgId, userId, role: 'owner', status: 'active' })
  )
}

describe('notification backfill', () => {
  afterEach(() => {
    resetEmailTransportForTesting()
  })

  it('processes all PENDING_DELIVERY security alerts and marks them delivered', async () => {
    const { boss, send } = createMockBoss()
    await boss.start()
    const ownerId = await createTestUser('backfill-owner')

    try {
      await withTestOrg(async ({ orgId }) => {
        await seedOwner(orgId, ownerId)
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
        expect(send).toHaveBeenCalledTimes(queueEntries.length)
        const queueIds = new Set(queueEntries.map((entry) => entry.id))
        for (const call of send.mock.calls) {
          expect(call[0]).toBe('notification/deliver')
          expect(queueIds.has(call[1]?.notificationQueueId as string)).toBe(true)
          expect(call[1]?.orgId).toBe(orgId)
        }
      })
    } finally {
      await deleteTestUser(ownerId)
    }
  })

  it('is idempotent — running twice does not double-enqueue', async () => {
    const { boss } = createMockBoss()
    await boss.start()
    const ownerId = await createTestUser('backfill-idempotent-owner')

    try {
      await withTestOrg(async ({ orgId }) => {
        await seedOwner(orgId, ownerId)
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
        expect(queueEntries).toHaveLength(2)
      })
    } finally {
      await deleteTestUser(ownerId)
    }
  })

  it('delivers a backfilled email queue entry to terminal delivered status', async () => {
    const { boss } = createMockBoss()
    await boss.start()
    setEmailTransportForTesting(nodemailer.createTransport({ jsonTransport: true }))
    const ownerId = await createTestUser('backfill-deliver-owner')

    try {
      await withTestOrg(async ({ orgId }) => {
        await seedOwner(orgId, ownerId)
        await withOrg(orgId, (tx) =>
          tx.insert(securityAlerts).values({
            orgId,
            alertType: FAILED_AUTH_TEMPLATE,
            severity: 'critical',
            status: 'PENDING_DELIVERY',
            payload: FAILED_AUTH_PAYLOAD,
          })
        )

        await runNotificationBackfill(boss, testLogger)

        const queueEntries = await withOrg(orgId, (tx) => tx.select().from(notificationQueue))
        const emailEntry = queueEntries.find((entry) => entry.channel === 'email')
        expect(emailEntry?.status).toBe('pending')

        if (!emailEntry) throw new Error('expected email queue entry')
        const updated = await expectQueueStatus(orgId, emailEntry.id, 'pending')
        expect(updated?.deliveredAt).toBeNull()

        await deliverNotification(emailEntry.id, orgId)

        const delivered = await expectQueueStatus(orgId, emailEntry.id, 'delivered')
        expect(delivered?.deliveredAt).not.toBeNull()
      })
    } finally {
      await deleteTestUser(ownerId)
    }
  })

  it('does not dispatch jobs when pg-boss has not been started, leaving queue rows pending', async () => {
    const { boss, send } = createMockBoss()
    const ownerId = await createTestUser('backfill-boss-not-started-owner')

    try {
      await withTestOrg(async ({ orgId }) => {
        await seedOwner(orgId, ownerId)
        await withOrg(orgId, (tx) =>
          tx.insert(securityAlerts).values({
            orgId,
            alertType: FAILED_AUTH_TEMPLATE,
            severity: 'critical',
            status: 'PENDING_DELIVERY',
            payload: { attemptCount: 10 },
          })
        )

        await runNotificationBackfill(boss, testLogger)

        const queueEntries = await withOrg(orgId, (tx) => tx.select().from(notificationQueue))
        expect(queueEntries.length).toBeGreaterThan(0)
        expect(queueEntries.every((entry) => entry.status === 'pending')).toBe(true)
        expect(send).not.toHaveBeenCalled()
      })
    } finally {
      await deleteTestUser(ownerId)
    }
  })
})
