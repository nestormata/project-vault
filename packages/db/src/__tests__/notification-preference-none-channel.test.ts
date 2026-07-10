import { describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { withOrg } from '../index.js'
import { notificationPreferences } from '../schema/index.js'
import { createTestUser, deleteTestUser, withTestOrg } from '../test-helpers.js'

const ALERT_TYPE = 'security.mfa_recovery_used'

describe('notification_preferences none-channel constraint', () => {
  it('allows storing channel none', async () => {
    const userId = await createTestUser('notification-prefs-none')
    try {
      await withTestOrg(async ({ orgId }) => {
        await withOrg(orgId, (tx) =>
          tx.insert(notificationPreferences).values({
            orgId,
            userId,
            alertType: ALERT_TYPE,
            channel: 'none',
            frequency: 'immediate',
            minSeverity: 'warning',
          })
        )

        const rows = await withOrg(orgId, (tx) =>
          tx
            .select({ channel: notificationPreferences.channel })
            .from(notificationPreferences)
            .where(sql`${notificationPreferences.userId} = ${userId}`)
        )

        expect(rows).toEqual([{ channel: 'none' }])
      })
    } finally {
      await deleteTestUser(userId)
    }
  })

  it('still rejects invalid channels', async () => {
    const userId = await createTestUser('notification-prefs-bogus')
    try {
      await withTestOrg(async ({ orgId }) => {
        await expect(
          withOrg(orgId, (tx) =>
            tx.execute(sql`
              INSERT INTO notification_preferences
                (org_id, user_id, alert_type, channel, frequency, min_severity)
              VALUES
                (${orgId}, ${userId}, ${ALERT_TYPE}, 'bogus', 'immediate', 'warning')
            `)
          )
        ).rejects.toThrow()
      })
    } finally {
      await deleteTestUser(userId)
    }
  })
})
