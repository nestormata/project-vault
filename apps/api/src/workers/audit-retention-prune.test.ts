import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { auditLogEntries } from '@project-vault/db/schema'
import { withTestOrg, withTwoTestOrgs } from '@project-vault/db/test-helpers'
import { configureRetention } from '../modules/audit/retention.js'
import { pruneExpiredAuditLogEntries } from './audit-retention-prune.js'

async function insertRow(orgId: string, eventType: string, createdAt: Date): Promise<void> {
  await withOrg(orgId, (tx) =>
    tx.insert(auditLogEntries).values({
      orgId,
      actorType: 'system',
      eventType,
      payload: {},
      keyVersion: 1,
      hmac: 'a'.repeat(64),
      createdAt,
    })
  )
}

async function countRows(orgId: string): Promise<number> {
  const rows = await withOrg(orgId, (tx) =>
    tx
      .select({ id: auditLogEntries.id })
      .from(auditLogEntries)
      .where(eq(auditLogEntries.orgId, orgId))
  )
  return rows.length
}

describe('pruneExpiredAuditLogEntries (AC-23)', () => {
  it('deletes only rows older than retentionDays for a configured org', async () => {
    await withTestOrg(async ({ orgId }) => {
      await withOrg(orgId, (tx) => configureRetention(tx, orgId, 30))
      await insertRow(orgId, 'test.old', new Date(Date.now() - 60 * 24 * 60 * 60 * 1000))
      await insertRow(orgId, 'test.new', new Date())

      await pruneExpiredAuditLogEntries()

      const remaining = await withOrg(orgId, (tx) =>
        tx
          .select({ eventType: auditLogEntries.eventType })
          .from(auditLogEntries)
          .where(eq(auditLogEntries.orgId, orgId))
      )
      expect(remaining.map((r) => r.eventType)).toEqual(['test.new'])
    })
  })

  it('skips an org with no retention config row at all (D7 default)', async () => {
    await withTestOrg(async ({ orgId }) => {
      await insertRow(
        orgId,
        'test.unconfigured.old',
        new Date(Date.now() - 400 * 24 * 60 * 60 * 1000)
      )

      await pruneExpiredAuditLogEntries()

      expect(await countRows(orgId)).toBe(1)
    })
  })

  it('only prunes the configured org, never a peer org (tenant isolation)', async () => {
    await withTwoTestOrgs(async ({ orgAId, orgBId }) => {
      await withOrg(orgAId, (tx) => configureRetention(tx, orgAId, 30))
      await insertRow(orgAId, 'orgA.old', new Date(Date.now() - 60 * 24 * 60 * 60 * 1000))
      await insertRow(orgBId, 'orgB.old', new Date(Date.now() - 60 * 24 * 60 * 60 * 1000))

      await pruneExpiredAuditLogEntries()

      expect(await countRows(orgAId)).toBe(0)
      expect(await countRows(orgBId)).toBe(1)
    })
  })

  it('is a no-op (no error) for a configured org with zero rows past the cutoff', async () => {
    await withTestOrg(async ({ orgId }) => {
      await withOrg(orgId, (tx) => configureRetention(tx, orgId, 30))
      await insertRow(orgId, 'test.recent', new Date())

      await expect(pruneExpiredAuditLogEntries()).resolves.toBeUndefined()
      expect(await countRows(orgId)).toBe(1)
    })
  })
})
