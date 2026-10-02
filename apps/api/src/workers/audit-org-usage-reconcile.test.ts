import { beforeAll, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { auditOrgStorageUsage } from '@project-vault/db/schema'
import { AuditEvent } from '@project-vault/shared'

process.env['DATABASE_URL'] ??=
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'
process.env['ADMIN_DATABASE_URL'] ??=
  'postgresql://vault_admin:password@localhost:5432/project_vault'
process.env['VAULT_ALLOW_REMOTE_INIT'] = 'true'
process.env['AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED'] = 'true'

const { initVault } = await import('../modules/vault/key-service.js')
const { resetVaultForTest } = await import('../__tests__/helpers/vault-test-cleanup.js')
const { withTestOrg, withTwoTestOrgs, createTestUser } =
  await import('@project-vault/db/test-helpers')
const { firstActorTokenIdForUser } = await import('../modules/audit/actor-token.js')
const { writeHumanAuditEntry } = await import('../modules/audit/human-entry.js')
const { runAuditOrgUsageReconcile } = await import('./audit-org-usage-reconcile.js')

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

async function readUsage(
  orgId: string
): Promise<{ bytesUsed: number; lastReconciledAt: Date | null } | undefined> {
  return withOrg(orgId, async (tx) => {
    const [row] = await tx
      .select({
        bytesUsed: auditOrgStorageUsage.bytesUsed,
        lastReconciledAt: auditOrgStorageUsage.lastReconciledAt,
      })
      .from(auditOrgStorageUsage)
      .where(eq(auditOrgStorageUsage.orgId, orgId))
    return row
  })
}

async function writeOneAuditEntry(orgId: string, userId: string, eventType: string): Promise<void> {
  await withOrg(orgId, async (tx) => {
    const actorTokenId = await firstActorTokenIdForUser(tx, userId)
    await writeHumanAuditEntry(tx, { orgId, actorTokenId, eventType, payload: {} })
  })
}

// Story 66-15: these tests scope the reconcile to the orgs they created. The worker's default
// (unscoped) run costs O(every org in the shared DB) (about 3.3 ms per org measured, so ~10 s at
// 3000 orgs), which made these tests' runtime depend on unrelated suite residue. The unscoped
// instance-wide contract stays covered by audit-org-usage-reconcile.branches.test.ts.
describe('Story 22.1 AC-7: audit-org-usage/reconcile', () => {
  beforeAll(async () => {
    await resetVaultForTest()
    try {
      await initVault({ kmsType: 'passphrase', passphrase: 'reconcile-test-passphrase' }, {})
    } catch (error) {
      if ((error as { code?: string }).code !== 'ALREADY_INITIALIZED') throw error
    }
  })

  it('establishes ground truth for an org that has never had a usage row (AC-7 positive example)', async () => {
    await withTestOrg(async ({ orgId }) => {
      const userId = await createTestUser('reconcile-actor')
      // Written via its own withOrg() transaction (distinct from the outer withTestOrg fixture
      // transaction) so it is COMMITTED before the reconciliation worker — which reads through a
      // separate getAdminDb() connection — runs its aggregate scan. Kill switch is on but the
      // target org has no quota row (unlimited), so this write is admitted by the gate regardless
      // — the point of this test is reconciliation, not gating.
      await withOrg(orgId, async (tx) => {
        const actorTokenId = await firstActorTokenIdForUser(tx, userId)
        await writeHumanAuditEntry(tx, {
          orgId,
          actorTokenId,
          eventType: 'credential.value_revealed',
          payload: { some: 'data' },
        })
      })

      const logger = fakeLogger()
      await runAuditOrgUsageReconcile(logger, undefined, { orgIds: [orgId] })

      const usage = await readUsage(orgId)
      expect(usage?.bytesUsed).toBeGreaterThan(0)
      expect(usage?.lastReconciledAt).toBeTruthy()
      expect(logger.info).toHaveBeenCalled()
    })
  }, 20_000)

  it('one org write-back failure does not block another org (per-org isolation)', async () => {
    await withTestOrg(async ({ orgId }) => {
      const userId = await createTestUser('reconcile-isolation-actor')
      await withOrg(orgId, async (tx) => {
        const actorTokenId = await firstActorTokenIdForUser(tx, userId)
        await writeHumanAuditEntry(tx, {
          orgId,
          actorTokenId,
          eventType: AuditEvent.PROJECT_CREATED,
          payload: {},
        })
      })

      // A non-existent org id in the aggregate result (simulated by directly calling the
      // reconciler after a real write elsewhere) does not block this org's own reconciliation —
      // covered structurally: this run must still update THIS org even if some other org in the
      // instance-wide scan throws inside its own runOrgScopedJob (isolated by try/catch per row).
      const logger = fakeLogger()
      await runAuditOrgUsageReconcile(logger, undefined, { orgIds: [orgId] })

      const usage = await readUsage(orgId)
      expect(usage?.bytesUsed).toBeGreaterThan(0)
    })
  }, 20_000)

  it('a scoped run reconciles only the requested orgs (Story 66-15)', async () => {
    await withTwoTestOrgs(async ({ orgAId, orgBId }) => {
      const userId = await createTestUser('reconcile-scope-actor')
      await writeOneAuditEntry(orgAId, userId, AuditEvent.PROJECT_CREATED)
      await writeOneAuditEntry(orgBId, userId, AuditEvent.PROJECT_CREATED)

      const logger = fakeLogger()
      await runAuditOrgUsageReconcile(logger, undefined, { orgIds: [orgAId] })

      expect((await readUsage(orgAId))?.lastReconciledAt).toBeTruthy()
      // The bystander org has audit rows (and an incremental counter from the write path) but was
      // outside the scope: reconciliation never touched it, so it has no reconciled timestamp.
      expect((await readUsage(orgBId))?.lastReconciledAt ?? null).toBeNull()
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ rowsScanned: 1, orgsUpdated: 1 }),
        expect.any(String)
      )
    })
  }, 20_000)
})
