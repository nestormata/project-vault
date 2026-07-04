import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { orgMemberships, paymentRecords, notificationQueue } from '@project-vault/db/schema'
import {
  withTestOrg,
  createTestUser,
  deleteTestUser,
  insertTestProject,
} from '@project-vault/db/test-helpers'
import { createMockBoss } from '../__tests__/helpers/notification-test-helpers.js'
import { runPaymentExpiryAlertJob } from './payment-expiry-alert.js'

async function seedOwner(orgId: string, userId: string) {
  await withOrg(orgId, (tx) =>
    tx.insert(orgMemberships).values({ orgId, userId, role: 'owner', status: 'active' })
  )
}

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 86_400_000)
}

const PAYMENT_EXPIRY_TEMPLATE_ID = 'payment.expiry'
const PAYMENT_RECORD_NOT_INSERTED = 'expected payment record to be inserted'

describe('payment expiry alert worker', () => {
  it('fires a notification and records the threshold in notifiedLeadDays', async () => {
    const { boss, send } = createMockBoss()
    await boss.start()
    const ownerId = await createTestUser('payment-expiry-owner')

    try {
      await withTestOrg(async ({ orgId }) => {
        await seedOwner(orgId, ownerId)
        const project = await insertTestProject(orgId, { userId: ownerId, slug: 'payment-expiry' })

        const [row] = await withOrg(orgId, (tx) =>
          tx
            .insert(paymentRecords)
            .values({
              orgId,
              projectId: project.id,
              name: 'AWS Hosting',
              renewalDate: daysFromNow(3),
              alertLeadDays: [14, 3],
              createdBy: ownerId,
            })
            .returning()
        )
        if (!row) throw new Error(PAYMENT_RECORD_NOT_INSERTED)

        await runPaymentExpiryAlertJob(boss)

        const [updated] = await withOrg(orgId, (tx) =>
          tx.select().from(paymentRecords).where(eq(paymentRecords.id, row.id))
        )
        expect(updated?.notifiedLeadDays).toEqual([3])

        const queueEntries = await withOrg(orgId, (tx) =>
          tx
            .select()
            .from(notificationQueue)
            .where(eq(notificationQueue.templateId, PAYMENT_EXPIRY_TEMPLATE_ID))
        )
        expect(queueEntries.length).toBeGreaterThan(0)
        expect((queueEntries[0]?.payload as Record<string, unknown>)?.['assetId']).toBe(row.id)
        expect(send).toHaveBeenCalled()
      })
    } finally {
      await deleteTestUser(ownerId)
    }
  }, 20_000)

  it('does not re-fire a threshold already present in notifiedLeadDays', async () => {
    const { boss } = createMockBoss()
    await boss.start()
    const ownerId = await createTestUser('payment-expiry-owner-2')

    try {
      await withTestOrg(async ({ orgId }) => {
        await seedOwner(orgId, ownerId)
        const project = await insertTestProject(orgId, {
          userId: ownerId,
          slug: 'payment-expiry-dedupe',
        })

        const [row] = await withOrg(orgId, (tx) =>
          tx
            .insert(paymentRecords)
            .values({
              orgId,
              projectId: project.id,
              name: 'GitHub SaaS seat',
              renewalDate: daysFromNow(2),
              alertLeadDays: [14, 3],
              notifiedLeadDays: [3],
              createdBy: ownerId,
            })
            .returning()
        )
        if (!row) throw new Error(PAYMENT_RECORD_NOT_INSERTED)

        await runPaymentExpiryAlertJob(boss)

        const queueEntries = await withOrg(orgId, (tx) =>
          tx
            .select()
            .from(notificationQueue)
            .where(eq(notificationQueue.templateId, PAYMENT_EXPIRY_TEMPLATE_ID))
        )
        expect(queueEntries).toHaveLength(0)
      })
    } finally {
      await deleteTestUser(ownerId)
    }
  }, 20_000)

  it('skips rows with a null renewalDate', async () => {
    const { boss } = createMockBoss()
    await boss.start()
    const ownerId = await createTestUser('payment-expiry-owner-3')

    try {
      await withTestOrg(async ({ orgId }) => {
        await seedOwner(orgId, ownerId)
        const project = await insertTestProject(orgId, { userId: ownerId, slug: 'payment-no-date' })

        await withOrg(orgId, (tx) =>
          tx.insert(paymentRecords).values({
            orgId,
            projectId: project.id,
            name: 'Not enrolled yet',
            renewalDate: null,
            createdBy: ownerId,
          })
        )

        await runPaymentExpiryAlertJob(boss)

        const queueEntries = await withOrg(orgId, (tx) =>
          tx
            .select()
            .from(notificationQueue)
            .where(eq(notificationQueue.templateId, PAYMENT_EXPIRY_TEMPLATE_ID))
        )
        expect(queueEntries).toHaveLength(0)
      })
    } finally {
      await deleteTestUser(ownerId)
    }
  }, 20_000)

  it('fires a critical overdue alert once for an already-expired renewal date', async () => {
    const { boss } = createMockBoss()
    await boss.start()
    const ownerId = await createTestUser('payment-expiry-owner-4')

    try {
      await withTestOrg(async ({ orgId }) => {
        await seedOwner(orgId, ownerId)
        const project = await insertTestProject(orgId, { userId: ownerId, slug: 'payment-overdue' })

        const [row] = await withOrg(orgId, (tx) =>
          tx
            .insert(paymentRecords)
            .values({
              orgId,
              projectId: project.id,
              name: 'Overdue Hosting',
              renewalDate: daysFromNow(-21),
              alertLeadDays: [14, 3],
              createdBy: ownerId,
            })
            .returning()
        )
        if (!row) throw new Error(PAYMENT_RECORD_NOT_INSERTED)

        await runPaymentExpiryAlertJob(boss)

        const [updated] = await withOrg(orgId, (tx) =>
          tx.select().from(paymentRecords).where(eq(paymentRecords.id, row.id))
        )
        expect(updated?.notifiedLeadDays).toEqual([0])

        const queueEntries = await withOrg(orgId, (tx) =>
          tx
            .select()
            .from(notificationQueue)
            .where(eq(notificationQueue.templateId, PAYMENT_EXPIRY_TEMPLATE_ID))
        )
        expect(
          queueEntries.some(
            (entry) => (entry.payload as Record<string, unknown>)?.['overdue'] === true
          )
        ).toBe(true)
      })
    } finally {
      await deleteTestUser(ownerId)
    }
  }, 20_000)
})
