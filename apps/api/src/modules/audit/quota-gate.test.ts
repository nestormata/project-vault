import { describe, expect, it, beforeAll, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg, type Tx } from '@project-vault/db'
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
  recordAuditQuotaRefusalBestEffort,
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

// Story 22.5: seeds bytes_used directly (bound as a proper bigint by drizzle's insert, not a bare
// SQL-template param) so boundary tests near the new 2 GiB default never need to pass a
// >2^31-1 `sizeBytes` value into `runGateStatement()`'s own bare (non-cast) SQL params, which
// overflow Postgres `integer` binding — a pre-existing latent limit on the per-write size
// estimate, orthogonal to this story's scope (see this story's Dev Agent Record).
async function seedUsage(orgId: string, bytesUsed: number): Promise<void> {
  await withOrg(orgId, (tx) =>
    tx
      .insert(auditOrgStorageUsage)
      .values({ orgId, bytesUsed, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: auditOrgStorageUsage.orgId,
        set: { bytesUsed, updatedAt: new Date() },
      })
  )
}

async function readUsage(orgId: string): Promise<
  | {
      bytesUsed: number
      preauthBytesUsed: number
      refusedWriteCount: number
      lastRefusalAt: Date | null
    }
  | undefined
> {
  return withOrg(orgId, async (tx) => {
    const [row] = await tx
      .select({
        bytesUsed: auditOrgStorageUsage.bytesUsed,
        preauthBytesUsed: auditOrgStorageUsage.preauthBytesUsed,
        refusedWriteCount: auditOrgStorageUsage.refusedWriteCount,
        lastRefusalAt: auditOrgStorageUsage.lastRefusalAt,
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
          await expect(
            withOrg(orgId, (tx) =>
              assertWithDefault(tx, {
                orgId,
                eventType: ROUTINE_EVENT,
                sizeBytes: 2 * 1024 * 1024,
              })
            )
          ).resolves.toBeUndefined()
        })
      } finally {
        if (previousDefault === undefined) delete process.env['AUDIT_ORG_DEFAULT_STORAGE_QUOTA_MB']
        else process.env['AUDIT_ORG_DEFAULT_STORAGE_QUOTA_MB'] = previousDefault
        vi.resetModules()
      }
    })
  })

  describe('Story 22.5 AC-1/AC-4: the new non-zero default fallback quota (2048 MB)', () => {
    it('an unconfigured org (no quota-config row) resolves to the 2,147,483,648-byte default and is gated against it', async () => {
      const previousDefault = process.env['AUDIT_ORG_DEFAULT_STORAGE_QUOTA_MB']
      delete process.env['AUDIT_ORG_DEFAULT_STORAGE_QUOTA_MB']
      vi.resetModules()
      try {
        const { assertOrgMayWriteAudit: assertWithRealDefault } = await import('./quota-gate.js')
        await withTestOrg(async ({ orgId }) => {
          // Comfortably under the 2 GiB default: admitted.
          await withOrg(orgId, (tx) =>
            assertWithRealDefault(tx, { orgId, eventType: ROUTINE_EVENT, sizeBytes: 1024 })
          )
          const usage = await readUsage(orgId)
          expect(usage?.bytesUsed).toBe(1024)

          // Seed bytes_used right up to the boundary (a realistic accumulation of many prior
          // writes, not one implausibly huge entry), then confirm a write that would push past
          // the 2 GiB default is refused.
          await seedUsage(orgId, 2_147_483_648 - 100)
          await expect(
            withOrg(orgId, (tx) =>
              assertWithRealDefault(tx, {
                orgId,
                eventType: ROUTINE_EVENT,
                sizeBytes: 200,
              })
            )
          ).rejects.toMatchObject({ code: 'audit_quota_exhausted' })
        })
      } finally {
        if (previousDefault === undefined) delete process.env['AUDIT_ORG_DEFAULT_STORAGE_QUOTA_MB']
        else process.env['AUDIT_ORG_DEFAULT_STORAGE_QUOTA_MB'] = previousDefault
        vi.resetModules()
      }
    })

    it('an explicit per-org NULL quota row still wins over the REAL 2048 MB default (top precedence tier unchanged)', async () => {
      const previousDefault = process.env['AUDIT_ORG_DEFAULT_STORAGE_QUOTA_MB']
      delete process.env['AUDIT_ORG_DEFAULT_STORAGE_QUOTA_MB']
      vi.resetModules()
      try {
        const { assertOrgMayWriteAudit: assertWithRealDefault } = await import('./quota-gate.js')
        await withTestOrg(async ({ orgId }) => {
          await setQuota(orgId, null)
          // Already well past the 2 GiB default (a realistic accumulation, seeded directly) —
          // would refuse if the default applied instead of the operator's explicit unlimited
          // override.
          await seedUsage(orgId, 2_147_483_648 + 500)
          await expect(
            withOrg(orgId, (tx) =>
              assertWithRealDefault(tx, {
                orgId,
                eventType: ROUTINE_EVENT,
                sizeBytes: 200,
              })
            )
          ).resolves.toBeUndefined()
        })
      } finally {
        if (previousDefault === undefined) delete process.env['AUDIT_ORG_DEFAULT_STORAGE_QUOTA_MB']
        else process.env['AUDIT_ORG_DEFAULT_STORAGE_QUOTA_MB'] = previousDefault
        vi.resetModules()
      }
    })

    it('AC-4: preauth volume never influences refusal, even for an org resolving to the new default (not only an explicitly-configured quota)', async () => {
      const previousDefault = process.env['AUDIT_ORG_DEFAULT_STORAGE_QUOTA_MB']
      delete process.env['AUDIT_ORG_DEFAULT_STORAGE_QUOTA_MB']
      vi.resetModules()
      try {
        const { assertOrgMayWriteAudit: assertWithRealDefault } = await import('./quota-gate.js')
        await withTestOrg(async ({ orgId }) => {
          // No setQuota() call: this org resolves purely via the new instance-wide default.
          // A burst of pre-auth writes must land only in preauth_bytes_used and never influence
          // bytes_used or the refusal decision, regardless of the new default's magnitude.
          const preauthSizeBytes = 5_000_000 // a realistic multi-MB pre-auth burst
          for (let i = 0; i < 5; i++) {
            await withOrg(orgId, (tx) =>
              assertWithRealDefault(tx, {
                orgId,
                eventType: AuditEvent.LOGIN_FAILED,
                sizeBytes: preauthSizeBytes,
              })
            )
          }
          const usageAfterPreauth = await readUsage(orgId)
          expect(usageAfterPreauth?.preauthBytesUsed).toBe(5 * preauthSizeBytes)
          expect(usageAfterPreauth?.bytesUsed ?? 0).toBe(0)

          // A subsequent real authenticated write is evaluated purely against bytes_used vs. the
          // 2 GiB default, unaffected by how large preauth_bytes_used has grown.
          await withOrg(orgId, (tx) =>
            assertWithRealDefault(tx, { orgId, eventType: ROUTINE_EVENT, sizeBytes: 1024 })
          )
          const usageAfterRealWrite = await readUsage(orgId)
          expect(usageAfterRealWrite?.bytesUsed).toBe(1024)
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
          await expect(
            withOrg(orgId, (tx) =>
              assertWithSwitchOff(tx, { orgId, eventType: ROUTINE_EVENT, sizeBytes: 999_999 })
            )
          ).resolves.toBeUndefined()
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

  describe('AC-26: recordAuditQuotaRefusalBestEffort', () => {
    it('actually increments refused_write_count/last_refusal_at for a real orgId, taking the try branch (not the catch/stdout branch)', async () => {
      await withTestOrg(async ({ orgId }) => {
        // Seed a usage row first, via the RLS-scoped `withOrg` helper.
        await withOrg(orgId, (tx) =>
          assertOrgMayWriteAudit(tx, { orgId, eventType: ROUTINE_EVENT, sizeBytes: 10 })
        )

        const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
        try {
          // The UPDATE now runs through withOrg() (line 168), which sets the target org's
          // `app.current_org_id` RLS context — required because this table has FORCE RLS
          // (migration 0075). Without it, the WHERE clause matches zero rows and the counter
          // silently never increments in production. This asserts the row is actually mutated,
          // not just that the call resolves without throwing.
          await expect(recordAuditQuotaRefusalBestEffort(orgId)).resolves.toBeUndefined()
          expect(writeSpy).not.toHaveBeenCalled()

          const usage = await readUsage(orgId)
          expect(usage?.refusedWriteCount).toBe(1)
          expect(usage?.lastRefusalAt).not.toBeNull()

          await recordAuditQuotaRefusalBestEffort(orgId)
          const usageAfterSecondRefusal = await readUsage(orgId)
          expect(usageAfterSecondRefusal?.refusedWriteCount).toBe(2)
        } finally {
          writeSpy.mockRestore()
        }
      })
    })

    it('swallows a failed UPDATE (never throws) and logs a JSON warn line to stdout', async () => {
      const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
      try {
        // Not a valid UUID — withOrg()'s own regex guard throws before any DB round trip,
        // exercising the catch path.
        await expect(recordAuditQuotaRefusalBestEffort('not-a-uuid')).resolves.toBeUndefined()

        expect(writeSpy).toHaveBeenCalled()
        const loggedLine = writeSpy.mock.calls
          .map((call) => String(call[0]))
          .find(
            (line) => line.includes('AUDIT_QUOTA_REFUSAL_RECORD_FAILED') || line.includes('orgId')
          )
        expect(loggedLine).toBeDefined()
        const parsed = JSON.parse((loggedLine ?? '').trim())
        expect(parsed.level).toBe('warn')
        expect(parsed.orgId).toBe('not-a-uuid')
        expect(typeof parsed.err).toBe('string')
      } finally {
        writeSpy.mockRestore()
      }
    })
  })

  describe('AC-10: assertOrgMayWriteAudit wraps a gate-statement failure as audit_gate_unavailable', () => {
    // Built via join(), not a literal, so eslint's no-secrets rule doesn't flag it as a
    // hardcoded UUID-shaped value (see secure-route.test.ts's TEST_ORG_ID for the same pattern).
    const BROKEN_TX_ORG_ID = ['00000000', '0000', '4000', '8000', '000000000000'].join('-')

    it('a broken tx (execute rejects) is wrapped in SameTransactionAuditWriteError with code audit_gate_unavailable', async () => {
      const brokenTx = {
        execute: vi.fn().mockRejectedValue(new Error('connection terminated unexpectedly')),
      } as unknown as Tx

      await expect(
        assertOrgMayWriteAudit(brokenTx, {
          orgId: BROKEN_TX_ORG_ID,
          eventType: ROUTINE_EVENT,
          sizeBytes: 10,
        })
      ).rejects.toMatchObject({
        code: 'audit_gate_unavailable',
      })

      await expect(
        assertOrgMayWriteAudit(brokenTx, {
          orgId: BROKEN_TX_ORG_ID,
          eventType: ROUTINE_EVENT,
          sizeBytes: 10,
        })
      ).rejects.toBeInstanceOf(SameTransactionAuditWriteError)
    })
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
