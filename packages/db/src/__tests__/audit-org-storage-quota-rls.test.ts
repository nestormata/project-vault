import { describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { getDb, withOrg } from '@project-vault/db'
import { auditOrgStorageUsage, auditStorageQuotaConfig } from '@project-vault/db/schema'

const { withTwoTestOrgs } = await import('../test-helpers.js')

// Story 22.1 AC-3/AC-30 #2 — RLS isolation for BOTH new tables, read AND write side (finding M3:
// a FOR SELECT policy would pass every read-only test below while leaving INSERT/UPDATE of an
// arbitrary org_id completely unrestricted for vault_app).
describe('Story 22.1 AC-3: RLS isolation on audit_storage_quota_config / audit_org_storage_usage', () => {
  it('read side: org A cannot see org B rows in either table', async () => {
    await withTwoTestOrgs(async ({ orgAId, orgBId }) => {
      await withOrg(orgBId, (tx) =>
        tx.insert(auditStorageQuotaConfig).values({ orgId: orgBId, quotaBytes: 100 })
      )
      await withOrg(orgBId, (tx) =>
        tx.insert(auditOrgStorageUsage).values({ orgId: orgBId, bytesUsed: 10 })
      )

      await withOrg(orgAId, async (tx) => {
        const quotaRows = await tx
          .select()
          .from(auditStorageQuotaConfig)
          .where(eq(auditStorageQuotaConfig.orgId, orgBId))
        expect(quotaRows).toHaveLength(0)

        const usageRows = await tx
          .select()
          .from(auditOrgStorageUsage)
          .where(eq(auditOrgStorageUsage.orgId, orgBId))
        expect(usageRows).toHaveLength(0)
      })
    })
  })

  it('write side: org A cannot INSERT a row for org B (WITH CHECK rejects it)', async () => {
    await withTwoTestOrgs(async ({ orgAId, orgBId }) => {
      await expect(
        withOrg(orgAId, (tx) =>
          tx.insert(auditStorageQuotaConfig).values({ orgId: orgBId, quotaBytes: 100 })
        )
      ).rejects.toThrow()

      await expect(
        withOrg(orgAId, (tx) =>
          tx.insert(auditOrgStorageUsage).values({ orgId: orgBId, bytesUsed: 10 })
        )
      ).rejects.toThrow()
    })
  })

  it('write side: org A cannot UPDATE org id on its own row to become org B (WITH CHECK rejects it)', async () => {
    await withTwoTestOrgs(async ({ orgAId, orgBId }) => {
      await withOrg(orgAId, (tx) =>
        tx.insert(auditOrgStorageUsage).values({ orgId: orgAId, bytesUsed: 5 })
      )
      await expect(
        withOrg(orgAId, (tx) =>
          tx
            .update(auditOrgStorageUsage)
            .set({ orgId: orgBId })
            .where(eq(auditOrgStorageUsage.orgId, orgAId))
        )
      ).rejects.toThrow()
    })
  })

  it('write side: UPDATE on the writing org keeps only that org affected — org B untouched', async () => {
    await withTwoTestOrgs(async ({ orgAId, orgBId }) => {
      await withOrg(orgAId, (tx) =>
        tx.insert(auditOrgStorageUsage).values({ orgId: orgAId, bytesUsed: 1 })
      )
      await withOrg(orgBId, (tx) =>
        tx.insert(auditOrgStorageUsage).values({ orgId: orgBId, bytesUsed: 1 })
      )
      await withOrg(orgAId, (tx) =>
        tx
          .update(auditOrgStorageUsage)
          .set({ bytesUsed: 999 })
          .where(eq(auditOrgStorageUsage.orgId, orgAId))
      )
      const [rowA] = await withOrg(orgAId, (tx) =>
        tx
          .select({ bytesUsed: auditOrgStorageUsage.bytesUsed })
          .from(auditOrgStorageUsage)
          .where(eq(auditOrgStorageUsage.orgId, orgAId))
      )
      const [rowB] = await withOrg(orgBId, (tx) =>
        tx
          .select({ bytesUsed: auditOrgStorageUsage.bytesUsed })
          .from(auditOrgStorageUsage)
          .where(eq(auditOrgStorageUsage.orgId, orgBId))
      )
      expect(rowA?.bytesUsed).toBe(999)
      expect(rowB?.bytesUsed).toBe(1)
    })
  })

  it('the classic RLS bypass shape: with no app.current_org_id set at all, reads return zero rows (never all rows) and inserts are rejected', async () => {
    await withTwoTestOrgs(async ({ orgAId }) => {
      await withOrg(orgAId, (tx) =>
        tx.insert(auditStorageQuotaConfig).values({ orgId: orgAId, quotaBytes: 1 })
      )
    })

    // No set_config('app.current_org_id', ...) call at all — NULLIF(current_setting(...), '')
    // must yield NULL, and `org_id = NULL` is never true.
    const rows = await getDb().select().from(auditStorageQuotaConfig)
    expect(rows).toHaveLength(0)

    // A separate transaction — once a statement is rejected by RLS, the transaction enters
    // Postgres's "aborted" state and cannot run further statements (including COMMIT), so the
    // rejecting statement must be the last one issued on its own transaction.
    await expect(
      getDb().execute(
        sql`INSERT INTO audit_storage_quota_config (org_id, quota_bytes) VALUES (gen_random_uuid(), 1)`
      )
    ).rejects.toThrow()
  })

  it('AC-16: deleting an organization cascades both new tables — no orphan rows', async () => {
    await withTwoTestOrgs(async ({ orgAId }) => {
      await withOrg(orgAId, (tx) =>
        tx.insert(auditStorageQuotaConfig).values({ orgId: orgAId, quotaBytes: 1 })
      )
      await withOrg(orgAId, (tx) => tx.insert(auditOrgStorageUsage).values({ orgId: orgAId }))
      await getDb().execute(sql`DELETE FROM organizations WHERE id = ${orgAId}`)

      const quotaRows = await getDb()
        .select()
        .from(auditStorageQuotaConfig)
        .where(eq(auditStorageQuotaConfig.orgId, orgAId))
      const usageRows = await getDb()
        .select()
        .from(auditOrgStorageUsage)
        .where(eq(auditOrgStorageUsage.orgId, orgAId))
      expect(quotaRows).toHaveLength(0)
      expect(usageRows).toHaveLength(0)
    })
  })
})
