import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg, type Tx } from '../index.js'
import { withTestOrg } from '../test-helpers.js'
import { auditLogEntries } from '../schema/index.js'

const TEST_EVENT_TYPE = 'user.login'

async function insertAuditLogRow(orgId: string, hmac: string): Promise<string> {
  const [row] = await withOrg(orgId, (tx: Tx) =>
    tx
      .insert(auditLogEntries)
      .values({ orgId, actorType: 'system', eventType: TEST_EVENT_TYPE, keyVersion: 1, hmac })
      .returning()
  )
  return row?.id as string
}

describe('audit_log_entries immutability', () => {
  it('allows INSERT', async () => {
    await withTestOrg(async ({ orgId }) => {
      const [row] = await withOrg(orgId, (tx) =>
        tx
          .insert(auditLogEntries)
          .values({
            orgId,
            actorType: 'system',
            eventType: TEST_EVENT_TYPE,
            keyVersion: 1,
            hmac: 'test-hmac-insert',
          })
          .returning()
      )
      expect(row?.orgId).toBe(orgId)
    })
  })

  it('throws on UPDATE', async () => {
    await withTestOrg(async ({ orgId }) => {
      const id = await insertAuditLogRow(orgId, 'test-hmac-update')

      await expect(
        withOrg(orgId, (tx) =>
          tx.update(auditLogEntries).set({ hmac: 'tampered' }).where(eq(auditLogEntries.id, id))
        )
      ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/append-only/) } })
    })
  })

  it('throws on DELETE', async () => {
    await withTestOrg(async ({ orgId }) => {
      const id = await insertAuditLogRow(orgId, 'test-hmac-delete')

      await expect(
        withOrg(orgId, (tx) => tx.delete(auditLogEntries).where(eq(auditLogEntries.id, id)))
      ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/append-only/) } })
    })
  })
})
