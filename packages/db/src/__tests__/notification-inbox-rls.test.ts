import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb, withOrg, withOrgAndUser } from '../index.js'
import { notificationInbox } from '../schema/notification-inbox.js'
import { createTestUser, deleteTestUser, withTestOrg } from '../test-helpers.js'
import { withTwoTestOrgs } from './credential-test-helpers.js'

const TEST_ALERT_TYPE = 'security.failed_auth_threshold'
const TEST_INBOX_EXPIRY = () => new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)

function testInboxInsert(orgId: string, userId: string) {
  return {
    orgId,
    userId,
    alertType: TEST_ALERT_TYPE,
    severity: 'warning',
    payload: { title: 'Test', body: 'Body' },
    expiresAt: TEST_INBOX_EXPIRY(),
  }
}

describe('notification inbox RLS isolation', () => {
  it('returns zero rows for bare getDb reads on notification_inbox', async () => {
    const userId = await createTestUser('inbox-bare-read')
    try {
      await withTestOrg(async ({ orgId }) => {
        await withOrgAndUser(orgId, userId, (tx) =>
          tx.insert(notificationInbox).values(testInboxInsert(orgId, userId))
        )

        const rows = await getDb().select().from(notificationInbox)
        expect(rows).toHaveLength(0)
      })
    } finally {
      await deleteTestUser(userId)
    }
  })

  it('org A cannot read org B inbox entries for the same user', async () => {
    const userId = await createTestUser('inbox-cross-org')
    try {
      await withTwoTestOrgs(async ({ orgAId, orgBId }) => {
        await withOrgAndUser(orgAId, userId, (tx) =>
          tx.insert(notificationInbox).values(testInboxInsert(orgAId, userId))
        )

        const orgBRows = await withOrgAndUser(orgBId, userId, (tx) =>
          tx.select().from(notificationInbox).where(eq(notificationInbox.orgId, orgAId))
        )
        expect(orgBRows).toHaveLength(0)
      })
    } finally {
      await deleteTestUser(userId)
    }
  })

  it('withOrg() resets current_user_id so inbox rows are hidden', async () => {
    const userId = await createTestUser('inbox-withorg-reset')
    try {
      await withTestOrg(async ({ orgId }) => {
        await withOrgAndUser(orgId, userId, (tx) =>
          tx.insert(notificationInbox).values(testInboxInsert(orgId, userId))
        )

        const rows = await withOrg(orgId, (tx) => tx.select().from(notificationInbox))
        expect(rows).toHaveLength(0)
      })
    } finally {
      await deleteTestUser(userId)
    }
  })
})
