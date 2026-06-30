import { describe, expect, it } from 'vitest'
import { getDb, withOrg } from '../index.js'
import { notificationQueue } from '../schema/index.js'
import { createTestUser, deleteTestUser, withTestOrg } from '../test-helpers.js'
import { withTwoTestOrgs } from './credential-test-helpers.js'

describe('notification_queue RLS isolation', () => {
  it('org A cannot read org B notification queue entries', async () => {
    const userId = await createTestUser('notification-queue-rls')
    try {
      await withTwoTestOrgs(async ({ orgAId, orgBId }) => {
        await withOrg(orgAId, (tx) =>
          tx.insert(notificationQueue).values({
            orgId: orgAId,
            channel: 'email',
            templateId: 'test',
            payload: {},
            status: 'pending',
          })
        )

        const orgBEntries = await withOrg(orgBId, (tx) => tx.select().from(notificationQueue))
        expect(orgBEntries.every((entry) => entry.orgId !== orgAId)).toBe(true)
      })
    } finally {
      await deleteTestUser(userId)
    }
  })

  it('org A cannot write to org B notification queue', async () => {
    const userId = await createTestUser('notification-queue-write')
    try {
      await withTestOrg(async ({ orgId: orgAId }) => {
        await withTestOrg(async ({ orgId: orgBId }) => {
          await expect(
            withOrg(orgAId, (tx) =>
              tx.insert(notificationQueue).values({
                orgId: orgBId,
                channel: 'email',
                templateId: 'test',
                payload: {},
                status: 'pending',
              })
            )
          ).rejects.toThrow()
        })
      })
    } finally {
      await deleteTestUser(userId)
    }
  })

  it('returns zero rows for bare getDb() reads', async () => {
    await withTestOrg(async ({ orgId, tx }) => {
      await tx.insert(notificationQueue).values({
        orgId,
        channel: 'email',
        templateId: 'test',
        payload: {},
        status: 'pending',
      })
    })

    const bareRows = await getDb().select().from(notificationQueue)
    expect(bareRows).toHaveLength(0)
  })
})
