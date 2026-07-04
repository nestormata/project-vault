import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { paymentRecords } from '@project-vault/db/schema'
import { insertTestProject } from '@project-vault/db/test-helpers'
import { createMockBoss } from '../__tests__/helpers/notification-test-helpers.js'
import {
  daysFromNow,
  expectNoQueueEntries,
  expectQueueEntryFired,
  queueEntriesForTemplate,
  withExpiryAlertTestOrg,
} from './expiry-alert-test-helpers.js'
import { runPaymentExpiryAlertJob } from './payment-expiry-alert.js'

const PAYMENT_EXPIRY_TEMPLATE_ID = 'payment.expiry'
const PAYMENT_RECORD_NOT_INSERTED = 'expected payment record to be inserted'

/** Inserts a payment record for the test org, defaulting createdBy to the seeded owner. */
async function insertPaymentRecord(
  orgId: string,
  ownerId: string,
  projectId: string,
  overrides: Partial<typeof paymentRecords.$inferInsert> & {
    name: string
    renewalDate: Date | null
  }
) {
  const [row] = await withOrg(orgId, (tx) =>
    tx
      .insert(paymentRecords)
      .values({ orgId, projectId, createdBy: ownerId, ...overrides })
      .returning()
  )
  if (!row) throw new Error(PAYMENT_RECORD_NOT_INSERTED)
  return row
}

async function fetchPaymentRecord(orgId: string, rowId: string) {
  const [row] = await withOrg(orgId, (tx) =>
    tx.select().from(paymentRecords).where(eq(paymentRecords.id, rowId))
  )
  return row
}

describe('payment expiry alert worker', () => {
  it('fires a notification and records the threshold in notifiedLeadDays', async () => {
    const { boss, send } = createMockBoss()
    await boss.start()

    await withExpiryAlertTestOrg('payment-expiry-owner', async ({ orgId, ownerId }) => {
      const project = await insertTestProject(orgId, { userId: ownerId, slug: 'payment-expiry' })
      const row = await insertPaymentRecord(orgId, ownerId, project.id, {
        name: 'AWS Hosting',
        renewalDate: daysFromNow(3),
        alertLeadDays: [14, 3],
      })

      await runPaymentExpiryAlertJob(boss)

      const updated = await fetchPaymentRecord(orgId, row.id)
      expect(updated?.notifiedLeadDays).toEqual([3])

      await expectQueueEntryFired(orgId, PAYMENT_EXPIRY_TEMPLATE_ID, row.id, send)
    })
  }, 20_000)

  it('does not re-fire a threshold already present in notifiedLeadDays', async () => {
    const { boss } = createMockBoss()
    await boss.start()

    await withExpiryAlertTestOrg('payment-expiry-owner-2', async ({ orgId, ownerId }) => {
      const project = await insertTestProject(orgId, {
        userId: ownerId,
        slug: 'payment-expiry-dedupe',
      })
      await insertPaymentRecord(orgId, ownerId, project.id, {
        name: 'GitHub SaaS seat',
        renewalDate: daysFromNow(2),
        alertLeadDays: [14, 3],
        notifiedLeadDays: [3],
      })

      await runPaymentExpiryAlertJob(boss)

      await expectNoQueueEntries(orgId, PAYMENT_EXPIRY_TEMPLATE_ID)
    })
  }, 20_000)

  it('skips rows with a null renewalDate', async () => {
    const { boss } = createMockBoss()
    await boss.start()

    await withExpiryAlertTestOrg('payment-expiry-owner-3', async ({ orgId, ownerId }) => {
      const project = await insertTestProject(orgId, { userId: ownerId, slug: 'payment-no-date' })
      await insertPaymentRecord(orgId, ownerId, project.id, {
        name: 'Not enrolled yet',
        renewalDate: null,
      })

      await runPaymentExpiryAlertJob(boss)

      await expectNoQueueEntries(orgId, PAYMENT_EXPIRY_TEMPLATE_ID)
    })
  }, 20_000)

  it('fires a critical overdue alert once for an already-expired renewal date', async () => {
    const { boss } = createMockBoss()
    await boss.start()

    await withExpiryAlertTestOrg('payment-expiry-owner-4', async ({ orgId, ownerId }) => {
      const project = await insertTestProject(orgId, { userId: ownerId, slug: 'payment-overdue' })
      const row = await insertPaymentRecord(orgId, ownerId, project.id, {
        name: 'Overdue Hosting',
        renewalDate: daysFromNow(-21),
        alertLeadDays: [14, 3],
      })

      await runPaymentExpiryAlertJob(boss)

      const updated = await fetchPaymentRecord(orgId, row.id)
      expect(updated?.notifiedLeadDays).toEqual([0])

      const queueEntries = await queueEntriesForTemplate(orgId, PAYMENT_EXPIRY_TEMPLATE_ID)
      expect(
        queueEntries.some(
          (entry) => (entry.payload as Record<string, unknown>)?.['overdue'] === true
        )
      ).toBe(true)
    })
  }, 20_000)
})
