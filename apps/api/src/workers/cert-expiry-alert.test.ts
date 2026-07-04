import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { orgMemberships, certRecords, notificationQueue } from '@project-vault/db/schema'
import {
  withTestOrg,
  createTestUser,
  deleteTestUser,
  insertTestProject,
} from '@project-vault/db/test-helpers'
import { createMockBoss } from '../__tests__/helpers/notification-test-helpers.js'
import { runCertExpiryAlertJob } from './cert-expiry-alert.js'

async function seedOwner(orgId: string, userId: string) {
  await withOrg(orgId, (tx) =>
    tx.insert(orgMemberships).values({ orgId, userId, role: 'owner', status: 'active' })
  )
}

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 86_400_000)
}

describe('certificate expiry alert worker', () => {
  it('fires a warning-severity notification at the 7-day threshold and records it', async () => {
    const { boss, send } = createMockBoss()
    await boss.start()
    const ownerId = await createTestUser('cert-expiry-owner')

    try {
      await withTestOrg(async ({ orgId }) => {
        await seedOwner(orgId, ownerId)
        const project = await insertTestProject(orgId, { userId: ownerId, slug: 'cert-expiry' })

        const [row] = await withOrg(orgId, (tx) =>
          tx
            .insert(certRecords)
            .values({
              orgId,
              projectId: project.id,
              domain: 'api.example.com',
              expiresAt: daysFromNow(7),
              alertLeadDays: [30, 7],
              createdBy: ownerId,
            })
            .returning()
        )
        if (!row) throw new Error('expected cert record to be inserted')

        await runCertExpiryAlertJob(boss)

        const [updated] = await withOrg(orgId, (tx) =>
          tx.select().from(certRecords).where(eq(certRecords.id, row.id))
        )
        expect(updated?.notifiedLeadDays).toEqual([7])

        const queueEntries = await withOrg(orgId, (tx) =>
          tx
            .select()
            .from(notificationQueue)
            .where(eq(notificationQueue.templateId, 'certificate.expiry'))
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
    const ownerId = await createTestUser('cert-expiry-owner-2')

    try {
      await withTestOrg(async ({ orgId }) => {
        await seedOwner(orgId, ownerId)
        const project = await insertTestProject(orgId, {
          userId: ownerId,
          slug: 'cert-expiry-dedupe',
        })

        await withOrg(orgId, (tx) =>
          tx.insert(certRecords).values({
            orgId,
            projectId: project.id,
            domain: 'dedupe.example.com',
            expiresAt: daysFromNow(6),
            alertLeadDays: [30, 7],
            notifiedLeadDays: [7],
            createdBy: ownerId,
          })
        )

        await runCertExpiryAlertJob(boss)

        const queueEntries = await withOrg(orgId, (tx) =>
          tx
            .select()
            .from(notificationQueue)
            .where(eq(notificationQueue.templateId, 'certificate.expiry'))
        )
        expect(queueEntries).toHaveLength(0)
      })
    } finally {
      await deleteTestUser(ownerId)
    }
  }, 20_000)
})
