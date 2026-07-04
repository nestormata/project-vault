import { expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { notificationQueue, orgMemberships } from '@project-vault/db/schema'
import { createTestUser, deleteTestUser, withTestOrg } from '@project-vault/db/test-helpers'

/** Shared by the cert/domain/payment expiry-alert worker specs (jscpd-ignored helper file). */
export async function seedOwner(orgId: string, userId: string): Promise<void> {
  await withOrg(orgId, (tx) =>
    tx.insert(orgMemberships).values({ orgId, userId, role: 'owner', status: 'active' })
  )
}

export function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 86_400_000)
}

export async function queueEntriesForTemplate(orgId: string, templateId: string) {
  return withOrg(orgId, (tx) =>
    tx.select().from(notificationQueue).where(eq(notificationQueue.templateId, templateId))
  )
}

/**
 * Wraps the createTestUser/withTestOrg/seedOwner/deleteTestUser boilerplate every expiry-alert
 * worker spec repeats: creates an owner-scoped test org, runs `run`, and always cleans up the
 * test user afterward (even if `run` throws).
 */
export async function withExpiryAlertTestOrg(
  ownerLabel: string,
  run: (ctx: { orgId: string; ownerId: string }) => Promise<void>
): Promise<void> {
  const ownerId = await createTestUser(ownerLabel)
  try {
    await withTestOrg(async ({ orgId }) => {
      await seedOwner(orgId, ownerId)
      await run({ orgId, ownerId })
    })
  } finally {
    await deleteTestUser(ownerId)
  }
}

/** Asserts a notification was queued and dispatched for `rowId` under `templateId`. */
export async function expectQueueEntryFired(
  orgId: string,
  templateId: string,
  rowId: string,
  send: unknown
): Promise<void> {
  const queueEntries = await queueEntriesForTemplate(orgId, templateId)
  expect(queueEntries.length).toBeGreaterThan(0)
  expect((queueEntries[0]?.payload as Record<string, unknown>)?.['assetId']).toBe(rowId)
  expect(send).toHaveBeenCalled()
}

/** Asserts no notification was queued for `templateId` in this org. */
export async function expectNoQueueEntries(orgId: string, templateId: string): Promise<void> {
  const queueEntries = await queueEntriesForTemplate(orgId, templateId)
  expect(queueEntries).toHaveLength(0)
}
