import { beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { notificationQueue } from '@project-vault/db/schema'
import { withTestOrg, withTwoTestOrgs } from '@project-vault/db/test-helpers'
import { initVaultForTest } from '../__tests__/helpers/auth-test-helpers.js'
import { resetVaultForTest } from '../__tests__/helpers/vault-test-cleanup.js'
import { applyDeliveryStatusUpdate, type NotificationQueueStatus } from './delivery-status.js'

// applyDeliveryStatusUpdate() writes a same-transaction audit entry (AC5) via
// writeSystemAuditEntryOrFailClosed, which needs a real (unsealed) vault to fetch the audit HMAC
// key — mirrors service-provisioning/routes.test.ts's identical vault-init precedent.
// resetVaultForTest() first, since a vault_state row may already exist from an earlier suite in
// this same database (re-running initVault against an already-initialized vault only proves
// ALREADY_INITIALIZED — it does not unseal this process's own in-memory key).
beforeAll(async () => {
  await resetVaultForTest()
  const { initVault } = await import('../modules/vault/key-service.js')
  await initVaultForTest(initVault, 'delivery-status-integration-vault-secret')
})

async function insertQueueEntry(
  orgId: string,
  status: NotificationQueueStatus = 'pending'
): Promise<string> {
  const [row] = await withOrg(orgId, (tx) =>
    tx
      .insert(notificationQueue)
      .values({
        orgId,
        channel: 'email',
        templateId: 'test.template',
        payload: {},
        status,
        providerId: 'test-provider',
      })
      .returning({ id: notificationQueue.id })
  )
  if (!row) throw new Error('expected queue row')
  return row.id
}

async function readStatus(orgId: string, id: string): Promise<string | undefined> {
  const [row] = await withOrg(orgId, (tx) =>
    tx.select().from(notificationQueue).where(eq(notificationQueue.id, id))
  )
  return row?.status
}

// Story 20.11 AC4/AC10 — the out-of-order/interleaved/duplicate delivery matrix, against real
// Postgres: whatever order a burst of events for the same row arrives in, the final stored status
// always matches the highest-rank event received.
describe('applyDeliveryStatusUpdate — AC4 ordering matrix (real Postgres)', () => {
  it('in-order delivery: sent -> delivered lands on delivered', async () => {
    await withTestOrg(async ({ orgId }) => {
      const id = await insertQueueEntry(orgId, 'pending')
      await applyDeliveryStatusUpdate({ notificationQueueId: id, orgId, newStatus: 'sent' })
      await applyDeliveryStatusUpdate({ notificationQueueId: id, orgId, newStatus: 'delivered' })
      expect(await readStatus(orgId, id)).toBe('delivered')
    })
  })

  it('fully-reversed delivery: delivered then sent — sent is discarded, stays delivered', async () => {
    await withTestOrg(async ({ orgId }) => {
      const id = await insertQueueEntry(orgId, 'pending')
      await applyDeliveryStatusUpdate({ notificationQueueId: id, orgId, newStatus: 'delivered' })
      const result = await applyDeliveryStatusUpdate({
        notificationQueueId: id,
        orgId,
        newStatus: 'sent',
      })
      expect(result).toEqual({ outcome: 'discarded_backward', currentStatus: 'delivered' })
      expect(await readStatus(orgId, id)).toBe('delivered')
    })
  })

  it('interleaved delivery: sent, bounced, delivered (late/stale) — stays bounced', async () => {
    await withTestOrg(async ({ orgId }) => {
      const id = await insertQueueEntry(orgId, 'pending')
      await applyDeliveryStatusUpdate({ notificationQueueId: id, orgId, newStatus: 'sent' })
      await applyDeliveryStatusUpdate({ notificationQueueId: id, orgId, newStatus: 'bounced' })
      const result = await applyDeliveryStatusUpdate({
        notificationQueueId: id,
        orgId,
        newStatus: 'delivered',
      })
      expect(result).toEqual({ outcome: 'discarded_backward', currentStatus: 'bounced' })
      expect(await readStatus(orgId, id)).toBe('bounced')
    })
  })

  it('exact-duplicate delivery: delivered redelivered twice is idempotent, stays delivered', async () => {
    await withTestOrg(async ({ orgId }) => {
      const id = await insertQueueEntry(orgId, 'pending')
      await applyDeliveryStatusUpdate({ notificationQueueId: id, orgId, newStatus: 'delivered' })
      const second = await applyDeliveryStatusUpdate({
        notificationQueueId: id,
        orgId,
        newStatus: 'delivered',
      })
      expect(second).toEqual({ outcome: 'idempotent_noop' })
      expect(await readStatus(orgId, id)).toBe('delivered')
    })
  })

  it('never moves a terminal status back to pending or sent', async () => {
    await withTestOrg(async ({ orgId }) => {
      const id = await insertQueueEntry(orgId, 'failed')
      const result = await applyDeliveryStatusUpdate({
        notificationQueueId: id,
        orgId,
        newStatus: 'pending',
      })
      expect(result).toEqual({ outcome: 'discarded_backward', currentStatus: 'failed' })
      expect(await readStatus(orgId, id)).toBe('failed')
    })
  })
})

// Story 20.11 AC3/AC10 — RLS/tenant isolation: a status update for org A's row cannot be applied
// while org B's RLS context is active, and passing org B's id for org A's row resolves nothing
// (the row is invisible under the wrong org's RLS context, exactly as `notification_queue`'s
// existing RLS policy already guarantees for every other read/write in this codebase).
describe('applyDeliveryStatusUpdate — AC10 RLS/tenant isolation (real Postgres)', () => {
  it('cannot apply an org A row update while scoped to org B', async () => {
    await withTwoTestOrgs(async ({ orgAId, orgBId }) => {
      const id = await insertQueueEntry(orgAId, 'sent')

      const result = await applyDeliveryStatusUpdate({
        notificationQueueId: id,
        orgId: orgBId,
        newStatus: 'delivered',
      })

      expect(result).toEqual({ outcome: 'not_found' })
      expect(await readStatus(orgAId, id)).toBe('sent')
    })
  })
})
