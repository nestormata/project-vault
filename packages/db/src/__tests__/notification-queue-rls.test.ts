import { describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
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

  // Story 70.1 AC6 — the exclusive claim's UPDATE run on a bare connection (no
  // app.current_org_id) matches nothing under FORCE RLS.
  it('a bare getDb() claim UPDATE affects zero rows', async () => {
    let queueId = ''
    await withTestOrg(async ({ orgId }) => {
      // Committed in its own org-scoped transaction (not withTestOrg's still-open tx), so the
      // bare connection below could see the row if RLS did not hide it.
      const [row] = await withOrg(orgId, (orgTx) =>
        orgTx
          .insert(notificationQueue)
          .values({ orgId, channel: 'email', templateId: 'test', payload: {}, status: 'pending' })
          .returning({ id: notificationQueue.id })
      )
      queueId = row?.id ?? ''

      const updated = await getDb().execute(sql`
        UPDATE notification_queue
           SET attempt_count = attempt_count + 1,
               last_attempt_at = now(),
               claim_expires_at = now() + interval '900 seconds'
         WHERE id = ${queueId}::uuid
           AND status = 'pending'
           AND (claim_expires_at IS NULL OR claim_expires_at <= now())
        RETURNING id
      `)
      expect(updated).toHaveLength(0)
      const [after] = await withOrg(orgId, (orgTx) =>
        orgTx
          .select({ attemptCount: notificationQueue.attemptCount })
          .from(notificationQueue)
          .where(eq(notificationQueue.id, queueId))
      )
      expect(after?.attemptCount).toBe(0)
    })
    expect(queueId).not.toBe('')
  })

  // Story 70.1 AC6 — vault_admin's 0090 column grant is not widened to the new columns.
  it('vault_admin cannot SELECT claim_expires_at or send_started_at', async () => {
    const rows = await getDb().execute<{ lease: boolean; marker: boolean; webhook: boolean }>(sql`
      SELECT
        has_column_privilege('vault_admin', 'notification_queue', 'claim_expires_at', 'SELECT') AS lease,
        has_column_privilege('vault_admin', 'notification_queue', 'send_started_at', 'SELECT') AS marker,
        has_column_privilege('vault_admin', 'notification_queue', 'provider_message_id', 'SELECT') AS webhook
    `)
    expect(rows[0]).toEqual({ lease: false, marker: false, webhook: true })
  })
})
