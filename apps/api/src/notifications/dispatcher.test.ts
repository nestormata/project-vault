import { describe, expect, it } from 'vitest'
import { withOrg } from '@project-vault/db'
import { notificationQueue, orgMemberships } from '@project-vault/db/schema'
import { withTestOrg, createTestUser, deleteTestUser } from '@project-vault/db/test-helpers'
import { createMockBoss } from '../__tests__/helpers/notification-test-helpers.js'
import { createOrgAdminNotificationEntries, sendNotificationJobs } from './dispatcher.js'

const FAILED_AUTH_TEMPLATE = 'security.failed_auth_threshold'

describe('notification dispatcher', () => {
  it('creates email entries for owner and admin members plus one slack entry', async () => {
    const userId = await createTestUser('dispatcher')
    const adminId = await createTestUser('dispatcher-admin')
    try {
      await withTestOrg(async ({ orgId }) => {
        await withOrg(orgId, (tx) =>
          tx.insert(orgMemberships).values([
            { orgId, userId, role: 'owner', status: 'active' },
            { orgId, userId: adminId, role: 'admin', status: 'active' },
          ])
        )

        const ids = await withOrg(orgId, (tx) =>
          createOrgAdminNotificationEntries({
            orgId,
            template: { templateId: FAILED_AUTH_TEMPLATE, payload: { attemptCount: 1 } },
            tx,
          })
        )

        expect(ids.emailIds).toHaveLength(2)
        expect(ids.slackId).toBeTruthy()

        const rows = await withOrg(orgId, (tx) => tx.select().from(notificationQueue))
        expect(rows.filter((row) => row.channel === 'email')).toHaveLength(2)
        expect(rows.filter((row) => row.channel === 'slack')).toHaveLength(1)
      })
    } finally {
      await deleteTestUser(adminId)
      await deleteTestUser(userId)
    }
  })

  it('sends pg-boss jobs after queue entries are created', async () => {
    const { boss, send } = createMockBoss()
    await boss.start()

    await sendNotificationJobs(boss, {
      emailIds: [{ id: crypto.randomUUID(), orgId: crypto.randomUUID() }],
      slackId: { id: crypto.randomUUID(), orgId: crypto.randomUUID() },
    })

    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[0]?.[0]).toBe('notification:email')
    expect(send.mock.calls[1]?.[0]).toBe('notification:slack')
  })
})
