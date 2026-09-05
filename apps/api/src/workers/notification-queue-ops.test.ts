import { beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { notificationQueue } from '@project-vault/db/schema'
import { withTestOrg } from '@project-vault/db/test-helpers'
import {
  configureAuthIntegrationEnv,
  initVaultForTest,
} from '../__tests__/helpers/auth-test-helpers.js'
import { resetVaultForTest } from '../__tests__/helpers/vault-test-cleanup.js'
import { markNotificationSuppressed } from './notification-queue-ops.js'

configureAuthIntegrationEnv()

// Story 20.11 AC4 — markNotificationSuppressed() now delegates to applyDeliveryStatusUpdate(),
// which writes a same-transaction audit entry and needs a real (unsealed) vault for the audit
// HMAC key.
beforeAll(async () => {
  await resetVaultForTest()
  const { initVault } = await import('../modules/vault/key-service.js')
  await initVaultForTest(initVault, 'notification-queue-ops-vault-secret')
})

async function insertQueueEntry(
  orgId: string,
  status: 'pending' | 'delivered' | 'failed' | 'suppressed'
) {
  const [row] = await withOrg(orgId, (tx) =>
    tx
      .insert(notificationQueue)
      .values({
        orgId,
        channel: 'email',
        templateId: 'security.failed_auth_threshold',
        payload: {},
        status,
      })
      .returning({ id: notificationQueue.id })
  )
  if (!row) throw new Error('expected queue row')
  return row.id
}

describe('notification queue ops', () => {
  it('marks pending entries suppressed', async () => {
    await withTestOrg(async ({ orgId }) => {
      const queueId = await insertQueueEntry(orgId, 'pending')

      await markNotificationSuppressed(queueId, orgId)

      const [updated] = await withOrg(orgId, (tx) =>
        tx.select().from(notificationQueue).where(eq(notificationQueue.id, queueId))
      )
      expect(updated?.status).toBe('suppressed')
    })
  })

  // Story 20.11 AC2/AC4: markNotificationSuppressed() now goes through the same rank-guarded
  // applyDeliveryStatusUpdate() every other status transition uses. `failed` and `suppressed`
  // share rank 3 (both terminal) — a same-rank move between two different terminal statuses is
  // intentional forward progress (see delivery-status.ts's DELIVERY_STATUS_RANK doc comment and
  // delivery-status.test.ts's "allows a same-rank transition between two terminal statuses"),
  // not a backward move to discard. This test previously asserted the opposite because the old
  // WHERE-status='pending' guard was a separate, inconsistent bypass of that same rank model —
  // exactly the AC4 violation this refactor removes.
  it('records a late suppression signal even after an earlier failure (same-rank terminal move)', async () => {
    await withTestOrg(async ({ orgId }) => {
      const queueId = await insertQueueEntry(orgId, 'failed')

      await markNotificationSuppressed(queueId, orgId)

      const [updated] = await withOrg(orgId, (tx) =>
        tx.select().from(notificationQueue).where(eq(notificationQueue.id, queueId))
      )
      expect(updated?.status).toBe('suppressed')
    })
  })
})
