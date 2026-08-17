import { describe, expect, it, beforeAll, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { auditOrgStorageUsage, auditStorageQuotaConfig } from '@project-vault/db/schema'
import { AuditEvent } from '@project-vault/shared'

process.env['DATABASE_URL'] ??=
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'
process.env['AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED'] = 'true'

const { withTestOrg, withTwoTestOrgs } = await import('@project-vault/db/test-helpers')
const {
  assertOrgMayWriteAudit,
  classifyAuditWriteExemption,
  estimateAuditEntrySizeBytes,
  PREAUTH_ATTRIBUTABLE_EVENT_TYPES,
  QUOTA_REMEDIATION_EVENT_TYPES,
} = await import('./quota-gate.js')
const { SameTransactionAuditWriteError } = await import('../../lib/secure-route.js')

const ROUTINE_EVENT = 'credential.value_revealed'

// RLS is FORCE-enabled + WITH CHECK on both tables (Story 24.1 has landed) — every touch needs
// the target org's RLS context set, so these helpers run through withOrg() rather than a bare
// getDb() call.
async function setQuota(orgId: string, quotaBytes: number | null): Promise<void> {
  await withOrg(orgId, (tx) =>
    tx
      .insert(auditStorageQuotaConfig)
      .values({ orgId, quotaBytes, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: auditStorageQuotaConfig.orgId,
        set: { quotaBytes, updatedAt: new Date() },
      })
  )
}

async function readUsage(
  orgId: string
): Promise<{ bytesUsed: number; preauthBytesUsed: number } | undefined> {
  return withOrg(orgId, async (tx) => {
    const [row] = await tx
      .select({
        bytesUsed: auditOrgStorageUsage.bytesUsed,
        preauthBytesUsed: auditOrgStorageUsage.preauthBytesUsed,
      })
      .from(auditOrgStorageUsage)
      .where(eq(auditOrgStorageUsage.orgId, orgId))
    return row
  })
}

describe.sequential('Story 22.1: assertOrgMayWriteAudit (the quota gate)', () => {
  beforeAll(() => {
    process.env['AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED'] = 'true'
  })

  describe('AC-11/AC-28/AC-29: exemption classification', () => {
    it('routes PREAUTH_ATTRIBUTABLE_EVENT_TYPES to "preauth", never "security_critical" or null', () => {
      for (const eventType of PREAUTH_ATTRIBUTABLE_EVENT_TYPES) {
        expect(classifyAuditWriteExemption(eventType)).toBe('preauth')
      }
    })

    it('routes QUOTA_REMEDIATION_EVENT_TYPES to "remediation"', () => {
      for (const eventType of QUOTA_REMEDIATION_EVENT_TYPES) {
        expect(classifyAuditWriteExemption(eventType)).toBe('remediation')
      }
    })

    it('a routine event classifies as null (not exempt)', () => {
      expect(classifyAuditWriteExemption(ROUTINE_EVENT)).toBeNull()
    })

    it('AUDIT_QUOTA_CONFIGURED is remediation, never security_critical (finding M2)', () => {
      expect(classifyAuditWriteExemption(AuditEvent.AUDIT_QUOTA_CONFIGURED)).toBe('remediation')
    })
  })

  describe('AC-9/AC-6: boundary and atomicity', () => {
    it('admits at exactly quota - n, refuses at quota - n + 1 (AC-9 boundary)', async () => {
      await withTestOrg(async ({ orgId, tx: _tx }) => {
        const n = 200
        await setQuota(orgId, n) // room for exactly one entry of size n
        await withOrg(orgId, (tx) =>
          assertOrgMayWriteAudit(tx, { orgId, eventType: ROUTINE_EVENT, sizeBytes: n })
        )
        const usage = await readUsage(orgId)
        expect(usage?.bytesUsed).toBe(n)

        await expect(
          withOrg(orgId, (tx) =>
            assertOrgMayWriteAudit(tx, { orgId, eventType: ROUTINE_EVENT, sizeBytes: 1 })
          )
        ).rejects.toMatchObject({ code: 'audit_quota_exhausted' })
      })
    })

    it('first-write guard: an org with no usage row and n > quota is refused, no row created (NF-20)', async () => {
      await withTestOrg(async ({ orgId }) => {
        await setQuota(orgId, 100)
        await expect(
          withOrg(orgId, (tx) =>
            assertOrgMayWriteAudit(tx, { orgId, eventType: ROUTINE_EVENT, sizeBytes: 500 })
          )
        ).rejects.toMatchObject({ code: 'audit_quota_exhausted' })
        const usage = await readUsage(orgId)
        expect(usage).toBeUndefined()
      })
    })

    it('refusal throws SameTransactionAuditWriteError with code audit_quota_exhausted', async () => {
      await withTestOrg(async ({ orgId }) => {
        await setQuota(orgId, 10)
        await expect(
          withOrg(orgId, (tx) =>
            assertOrgMayWriteAudit(tx, { orgId, eventType: ROUTINE_EVENT, sizeBytes: 999 })
          )
        ).rejects.toBeInstanceOf(SameTransactionAuditWriteError)
      })
    })
  })

  describe('AC-11/AC-29: exempt writes are admitted over quota, accounted to the right column', () => {
    it('a remediation event is admitted even when it would exceed quota, and still increments bytes_used', async () => {
      await withTestOrg(async ({ orgId }) => {
        await setQuota(orgId, 10)
        await withOrg(orgId, (tx) =>
          assertOrgMayWriteAudit(tx, {
            orgId,
            eventType: AuditEvent.AUDIT_QUOTA_CONFIGURED,
            sizeBytes: 500,
          })
        )
        const usage = await readUsage(orgId)
        expect(usage?.bytesUsed).toBe(500)
      })
    })

    it('a preauth event is admitted even at 100x quota, and lands in preauth_bytes_used, never bytes_used (AC-29 security invariant, state half)', async () => {
      await withTestOrg(async ({ orgId }) => {
        await setQuota(orgId, 1) // tiny quota — a routine write would be refused instantly
        await withOrg(orgId, (tx) =>
          assertOrgMayWriteAudit(tx, {
            orgId,
            eventType: AuditEvent.LOGIN_FAILED,
            sizeBytes: 100 * 1024 * 1024, // 100 MiB, vastly over the 1-byte quota
          })
        )
        const usage = await readUsage(orgId)
        expect(usage?.preauthBytesUsed).toBe(100 * 1024 * 1024)
        expect(usage?.bytesUsed ?? 0).toBe(0)

        // The org's ordinary, non-exempt writes still succeed — pre-auth volume never refuses
        // anyone (AC-29's core property).
        await withOrg(orgId, (tx) =>
          assertOrgMayWriteAudit(tx, {
            orgId,
            eventType: AuditEvent.AUDIT_QUOTA_CONFIGURED,
            sizeBytes: 1,
          })
        )
      })
    })
  })

  describe('AC-4: quota precedence', () => {
    it('an explicit per-org NULL quota row means unlimited for that org, overriding the env default', async () => {
      const previousDefault = process.env['AUDIT_ORG_DEFAULT_STORAGE_QUOTA_MB']
      process.env['AUDIT_ORG_DEFAULT_STORAGE_QUOTA_MB'] = '1'
      process.env['AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED'] = 'true'
      vi.resetModules()
      try {
        const { assertOrgMayWriteAudit: assertWithDefault } = await import('./quota-gate.js')
        await withTestOrg(async ({ orgId }) => {
          await setQuota(orgId, null)
          // 2 MiB, larger than the 1 MB env default — would refuse if the default applied.
          await withOrg(orgId, (tx) =>
            assertWithDefault(tx, {
              orgId,
              eventType: ROUTINE_EVENT,
              sizeBytes: 2 * 1024 * 1024,
            })
          )
        })
      } finally {
        if (previousDefault === undefined) delete process.env['AUDIT_ORG_DEFAULT_STORAGE_QUOTA_MB']
        else process.env['AUDIT_ORG_DEFAULT_STORAGE_QUOTA_MB'] = previousDefault
        vi.resetModules()
      }
    })
  })

  describe('AC-25: the kill switch', () => {
    it('with enforcement disabled, a write past a tiny configured quota is never refused', async () => {
      // env.ts parses process.env ONCE into a module-level singleton at import time (AC-25's own
      // "in process memory" resolver), so flipping process.env mid-test requires a fresh module
      // graph — vi.resetModules() + a scoped dynamic re-import, not a mutation of the
      // already-imported `env` object.
      const previous = process.env['AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED']
      process.env['AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED'] = 'false'
      vi.resetModules()
      try {
        const { assertOrgMayWriteAudit: assertWithSwitchOff } = await import('./quota-gate.js')
        await withTestOrg(async ({ orgId }) => {
          await setQuota(orgId, 1)
          await withOrg(orgId, (tx) =>
            assertWithSwitchOff(tx, { orgId, eventType: ROUTINE_EVENT, sizeBytes: 999_999 })
          )
        })
      } finally {
        if (previous === undefined) delete process.env['AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED']
        else process.env['AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED'] = previous
        vi.resetModules()
      }
    })
  })

  describe('AC-12/AC-15: cross-org isolation — org A over quota never affects org B', () => {
    it("org A's refusal does not touch org B's row or success rate", async () => {
      await withTwoTestOrgs(async ({ orgAId, orgBId }) => {
        await setQuota(orgAId, 10)
        await withOrg(orgBId, (tx) =>
          assertOrgMayWriteAudit(tx, { orgId: orgBId, eventType: ROUTINE_EVENT, sizeBytes: 500 })
        )

        await expect(
          withOrg(orgAId, (tx) =>
            assertOrgMayWriteAudit(tx, { orgId: orgAId, eventType: ROUTINE_EVENT, sizeBytes: 500 })
          )
        ).rejects.toMatchObject({ code: 'audit_quota_exhausted' })

        // Org B keeps succeeding, at 100%, unaffected by org A's refusal.
        for (let i = 0; i < 5; i++) {
          await withOrg(orgBId, (tx) =>
            assertOrgMayWriteAudit(tx, { orgId: orgBId, eventType: ROUTINE_EVENT, sizeBytes: 10 })
          )
        }
        const usageB = await readUsage(orgBId)
        expect(usageB?.bytesUsed).toBe(500 + 5 * 10)
      })
    })
  })

  describe('AC-6: concurrent overshoot — real concurrency, independent connections, never sequential', () => {
    it('with room for exactly 3 entries, 20 concurrent writes admit exactly 3 and refuse 17, bytes_used never exceeds quota', async () => {
      await withTestOrg(async ({ orgId }) => {
        const entrySize = 100
        await setQuota(orgId, entrySize * 3)

        const attempts = Array.from({ length: 20 }, () =>
          withOrg(orgId, (tx) =>
            assertOrgMayWriteAudit(tx, { orgId, eventType: ROUTINE_EVENT, sizeBytes: entrySize })
          )
        )
        const results = await Promise.allSettled(attempts)
        const admitted = results.filter((r) => r.status === 'fulfilled').length
        const refused = results.filter((r) => r.status === 'rejected').length

        expect(admitted).toBe(3)
        expect(refused).toBe(17)
        const usage = await readUsage(orgId)
        expect(usage?.bytesUsed).toBeLessThanOrEqual(entrySize * 3)
        expect(usage?.bytesUsed).toBe(entrySize * 3)
      })
    }, 20_000)
  })

  describe('estimateAuditEntrySizeBytes', () => {
    it('grows with payload size and never returns a non-positive number', () => {
      const small = estimateAuditEntrySizeBytes({ payload: {} })
      const large = estimateAuditEntrySizeBytes({ payload: { blob: 'x'.repeat(10_000) } })
      expect(small).toBeGreaterThan(0)
      expect(large).toBeGreaterThan(small)
    })
  })

  afterEach(async () => {
    // AC-30's cleanup discipline for shared-fixture quota/usage state — withTestOrg/withTwoTestOrgs
    // already delete the org row (FK CASCADE takes both new tables with it), so nothing further is
    // needed here for org-scoped fixtures. This hook exists as a placeholder should a future test
    // in this file use a shared (non-per-test) org.
  })
})
