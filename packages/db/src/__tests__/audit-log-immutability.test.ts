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

  // 0002_audit_log_revoke.sql revokes UPDATE/DELETE on audit_log_entries from vault_app
  // as defense-in-depth alongside the append-only trigger. PostgreSQL checks table-level
  // privileges before firing row-level triggers, so the grant-layer REVOKE is what
  // actually blocks these statements now — "permission denied", not "append-only".
  // Either layer alone satisfies AC-5 (UPDATE/DELETE always throws); this asserts the
  // grant layer specifically, since it now fires first.
  it('throws on UPDATE', async () => {
    await withTestOrg(async ({ orgId }) => {
      const id = await insertAuditLogRow(orgId, 'test-hmac-update')

      await expect(
        withOrg(orgId, (tx) =>
          tx.update(auditLogEntries).set({ hmac: 'tampered' }).where(eq(auditLogEntries.id, id))
        )
      ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/permission denied/) } })
    })
  })

  it('throws on DELETE', async () => {
    await withTestOrg(async ({ orgId }) => {
      const id = await insertAuditLogRow(orgId, 'test-hmac-delete')

      await expect(
        withOrg(orgId, (tx) => tx.delete(auditLogEntries).where(eq(auditLogEntries.id, id)))
      ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/permission denied/) } })
    })
  })
})
