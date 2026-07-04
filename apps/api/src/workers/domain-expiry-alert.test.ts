import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { orgMemberships, domainRecords, notificationQueue } from '@project-vault/db/schema'
import {
  withTestOrg,
  createTestUser,
  deleteTestUser,
  insertTestProject,
} from '@project-vault/db/test-helpers'
import { createMockBoss } from '../__tests__/helpers/notification-test-helpers.js'
import { runDomainExpiryAlertJob } from './domain-expiry-alert.js'

async function seedOwner(orgId: string, userId: string) {
  await withOrg(orgId, (tx) =>
    tx.insert(orgMemberships).values({ orgId, userId, role: 'owner', status: 'active' })
  )
}

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 86_400_000)
}

const DOMAIN_EXPIRY_TEMPLATE_ID = 'domain.expiry'

describe('domain expiry alert worker', () => {
  it('fires a deliverable (warning-severity) notification at a 7-day threshold and records it', async () => {
    const { boss, send } = createMockBoss()
    await boss.start()
    const ownerId = await createTestUser('domain-expiry-owner')

    try {
      await withTestOrg(async ({ orgId }) => {
        await seedOwner(orgId, ownerId)
        const project = await insertTestProject(orgId, { userId: ownerId, slug: 'domain-expiry' })

        const [row] = await withOrg(orgId, (tx) =>
          tx
            .insert(domainRecords)
            .values({
              orgId,
              projectId: project.id,
              domainName: 'example.com',
              renewalDate: daysFromNow(7),
              alertLeadDays: [30, 7],
              createdBy: ownerId,
            })
            .returning()
        )
        if (!row) throw new Error('expected domain record to be inserted')

        await runDomainExpiryAlertJob(boss)

        const [updated] = await withOrg(orgId, (tx) =>
          tx.select().from(domainRecords).where(eq(domainRecords.id, row.id))
        )
        expect(updated?.notifiedLeadDays).toEqual([7])

        const queueEntries = await withOrg(orgId, (tx) =>
          tx
            .select()
            .from(notificationQueue)
            .where(eq(notificationQueue.templateId, DOMAIN_EXPIRY_TEMPLATE_ID))
        )
        expect(queueEntries.length).toBeGreaterThan(0)
        expect((queueEntries[0]?.payload as Record<string, unknown>)?.['assetId']).toBe(row.id)
        expect(send).toHaveBeenCalled()
      })
    } finally {
      await deleteTestUser(ownerId)
    }
  }, 20_000)

  it('does not re-fire the same threshold on the following day', async () => {
    const { boss } = createMockBoss()
    await boss.start()
    const ownerId = await createTestUser('domain-expiry-owner-2')

    try {
      await withTestOrg(async ({ orgId }) => {
        await seedOwner(orgId, ownerId)
        const project = await insertTestProject(orgId, {
          userId: ownerId,
          slug: 'domain-expiry-dedupe',
        })

        await withOrg(orgId, (tx) =>
          tx.insert(domainRecords).values({
            orgId,
            projectId: project.id,
            domainName: 'dedupe.example.com',
            renewalDate: daysFromNow(6),
            alertLeadDays: [30, 7],
            notifiedLeadDays: [7],
            createdBy: ownerId,
          })
        )

        await runDomainExpiryAlertJob(boss)

        const queueEntries = await withOrg(orgId, (tx) =>
          tx
            .select()
            .from(notificationQueue)
            .where(eq(notificationQueue.templateId, DOMAIN_EXPIRY_TEMPLATE_ID))
        )
        expect(queueEntries).toHaveLength(0)
      })
    } finally {
      await deleteTestUser(ownerId)
    }
  }, 20_000)

  it('does not fire for a renewal date far outside any configured threshold', async () => {
    const { boss } = createMockBoss()
    await boss.start()
    const ownerId = await createTestUser('domain-expiry-owner-3')

    try {
      await withTestOrg(async ({ orgId }) => {
        await seedOwner(orgId, ownerId)
        const project = await insertTestProject(orgId, {
          userId: ownerId,
          slug: 'domain-expiry-far',
        })

        await withOrg(orgId, (tx) =>
          tx.insert(domainRecords).values({
            orgId,
            projectId: project.id,
            domainName: 'far-out.example.com',
            renewalDate: daysFromNow(200),
            alertLeadDays: [30],
            createdBy: ownerId,
          })
        )

        await runDomainExpiryAlertJob(boss)

        const queueEntries = await withOrg(orgId, (tx) =>
          tx
            .select()
            .from(notificationQueue)
            .where(eq(notificationQueue.templateId, DOMAIN_EXPIRY_TEMPLATE_ID))
        )
        expect(queueEntries).toHaveLength(0)
      })
    } finally {
      await deleteTestUser(ownerId)
    }
  }, 20_000)

  it("advances notifiedLeadDays for the default 30-day (info-severity) threshold even though the default admin preference (minSeverity warning) filters the delivery — documents this interaction rather than hiding it; the alert cycle still won't re-fire on day 29", async () => {
    const { boss } = createMockBoss()
    await boss.start()
    const ownerId = await createTestUser('domain-expiry-owner-4')

    try {
      await withTestOrg(async ({ orgId }) => {
        await seedOwner(orgId, ownerId)
        const project = await insertTestProject(orgId, {
          userId: ownerId,
          slug: 'domain-expiry-info',
        })

        const [row] = await withOrg(orgId, (tx) =>
          tx
            .insert(domainRecords)
            .values({
              orgId,
              projectId: project.id,
              domainName: 'info-severity.example.com',
              renewalDate: daysFromNow(30),
              alertLeadDays: [30],
              createdBy: ownerId,
            })
            .returning()
        )
        if (!row) throw new Error('expected domain record to be inserted')

        await runDomainExpiryAlertJob(boss)

        const [updated] = await withOrg(orgId, (tx) =>
          tx.select().from(domainRecords).where(eq(domainRecords.id, row.id))
        )
        expect(updated?.notifiedLeadDays).toEqual([30])

        const queueEntries = await withOrg(orgId, (tx) =>
          tx
            .select()
            .from(notificationQueue)
            .where(eq(notificationQueue.templateId, DOMAIN_EXPIRY_TEMPLATE_ID))
        )
        // Default org-admin preference min severity is 'warning' (Story 3.2); an 'info'-severity
        // alert is correctly filtered at the routing/preference layer — no queue row is created —
        // but the threshold is still consumed so the daily job doesn't keep re-evaluating it.
        expect(queueEntries).toHaveLength(0)
      })
    } finally {
      await deleteTestUser(ownerId)
    }
  }, 20_000)
})
