import { describe, expect, it } from 'vitest'
import { getDb, withOrg } from '../index.js'
import { notificationPreferences, orgNotificationRouting } from '../schema/index.js'
import { createTestUser, deleteTestUser, withTestOrg } from '../test-helpers.js'
import { withTwoTestOrgs } from './credential-test-helpers.js'

const TEST_ALERT_TYPE = 'service.down'
const TEST_CHANNEL = 'email'
const TEST_FREQUENCY = 'immediate'
const TEST_MIN_SEVERITY = 'warning'

describe('notification preferences RLS isolation', () => {
  it('org A cannot read org B notification preferences', async () => {
    const userId = await createTestUser('notification-prefs-rls')
    try {
      await withTwoTestOrgs(async ({ orgAId, orgBId }) => {
        await withOrg(orgAId, (tx) =>
          tx.insert(notificationPreferences).values({
            orgId: orgAId,
            userId,
            alertType: TEST_ALERT_TYPE,
            channel: TEST_CHANNEL,
            frequency: TEST_FREQUENCY,
            minSeverity: TEST_MIN_SEVERITY,
          })
        )

        const orgBRows = await withOrg(orgBId, (tx) => tx.select().from(notificationPreferences))
        expect(orgBRows.every((row) => row.orgId !== orgAId)).toBe(true)
      })
    } finally {
      await deleteTestUser(userId)
    }
  })

  it('org A cannot write org B notification routing', async () => {
    await withTestOrg(async ({ orgId: orgAId }) => {
      await withTestOrg(async ({ orgId: orgBId }) => {
        await expect(
          withOrg(orgAId, (tx) =>
            tx.insert(orgNotificationRouting).values({
              orgId: orgBId,
              alertType: TEST_ALERT_TYPE,
              routeTo: 'admin',
            })
          )
        ).rejects.toThrow()
      })
    })
  })

  it('returns zero rows for bare getDb reads on notification_preferences', async () => {
    const userId = await createTestUser('notification-prefs-bare')
    try {
      await withTestOrg(async ({ orgId, tx }) => {
        await tx.insert(notificationPreferences).values({
          orgId,
          userId,
          alertType: TEST_ALERT_TYPE,
          channel: TEST_CHANNEL,
          frequency: TEST_FREQUENCY,
          minSeverity: TEST_MIN_SEVERITY,
        })
      })

      const rows = await getDb().select().from(notificationPreferences)
      expect(rows).toHaveLength(0)
    } finally {
      await deleteTestUser(userId)
    }
  })
})
