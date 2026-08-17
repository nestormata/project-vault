import { describe, expect, it, beforeAll, vi } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { withOrg, type Tx } from '@project-vault/db'
import { auditOrgStorageUsage, auditStorageQuotaConfig } from '@project-vault/db/schema'
import { AuditEvent } from '@project-vault/shared'

process.env['DATABASE_URL'] ??=
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'
process.env['AUDIT_ORG_WRITE_RATE_ENFORCEMENT_ENABLED'] = 'true'
// Story 22.2's own gate must be exercisable independently of Story 22.1's — leave the storage
// gate OFF here so a test failure can never be misattributed to the wrong gate.
process.env['AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED'] = 'false'

const { withTestOrg, withTwoTestOrgs } = await import('@project-vault/db/test-helpers')
const {
  assertOrgMayWriteAuditAtRate,
  recordAuditRateRefusalBestEffort,
  classifyAuditWriteExemption,
} = await import('./quota-gate.js')
const { SameTransactionAuditWriteError } = await import('../../lib/secure-route.js')

const ROUTINE_EVENT = 'credential.value_revealed'

async function setRateCap(orgId: string, writeRatePerMinute: number | null): Promise<void> {
  await withOrg(orgId, (tx) =>
    tx
      .insert(auditStorageQuotaConfig)
      .values({ orgId, writeRatePerMinute, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: auditStorageQuotaConfig.orgId,
        set: { writeRatePerMinute, updatedAt: new Date() },
      })
  )
}

async function readUsage(orgId: string): Promise<
  | {
      rateWindowCount: number
      rateWindowResetAt: Date | null
      preauthRateWindowCount: number
      rateRefusedCount: number
      lastRateRefusalAt: Date | null
    }
  | undefined
> {
  return withOrg(orgId, async (tx) => {
    const [row] = await tx
      .select({
        rateWindowCount: auditOrgStorageUsage.rateWindowCount,
        rateWindowResetAt: auditOrgStorageUsage.rateWindowResetAt,
        preauthRateWindowCount: auditOrgStorageUsage.preauthRateWindowCount,
        rateRefusedCount: auditOrgStorageUsage.rateRefusedCount,
        lastRateRefusalAt: auditOrgStorageUsage.lastRateRefusalAt,
      })
      .from(auditOrgStorageUsage)
      .where(eq(auditOrgStorageUsage.orgId, orgId))
    return row
  })
}

describe.sequential('Story 22.2: assertOrgMayWriteAuditAtRate (the rate gate)', () => {
  beforeAll(() => {
    process.env['AUDIT_ORG_WRITE_RATE_ENFORCEMENT_ENABLED'] = 'true'
  })

  describe('AC-5/AC-8: boundary and atomicity', () => {
    it('admits exactly up to cap, refuses the (cap+1)th write in the same window', async () => {
      await withTestOrg(async ({ orgId }) => {
        await setRateCap(orgId, 3)
        for (let i = 0; i < 3; i++) {
          await withOrg(orgId, (tx) =>
            assertOrgMayWriteAuditAtRate(tx, { orgId, eventType: ROUTINE_EVENT })
          )
        }
        const usage = await readUsage(orgId)
        expect(usage?.rateWindowCount).toBe(3)

        await expect(
          withOrg(orgId, (tx) =>
            assertOrgMayWriteAuditAtRate(tx, { orgId, eventType: ROUTINE_EVENT })
          )
        ).rejects.toMatchObject({ code: 'audit_rate_limited' })
        const usageAfter = await readUsage(orgId)
        expect(usageAfter?.rateWindowCount).toBe(3)
      })
    })

    it('refusal throws SameTransactionAuditWriteError with code audit_rate_limited', async () => {
      await withTestOrg(async ({ orgId }) => {
        await setRateCap(orgId, 1)
        await withOrg(orgId, (tx) =>
          assertOrgMayWriteAuditAtRate(tx, { orgId, eventType: ROUTINE_EVENT })
        )
        await expect(
          withOrg(orgId, (tx) =>
            assertOrgMayWriteAuditAtRate(tx, { orgId, eventType: ROUTINE_EVENT })
          )
        ).rejects.toBeInstanceOf(SameTransactionAuditWriteError)
      })
    })

    it('window rollover: an expired window resets the count and admits the next write even though the previous window was at cap', async () => {
      await withTestOrg(async ({ orgId }) => {
        await setRateCap(orgId, 1)
        await withOrg(orgId, (tx) =>
          assertOrgMayWriteAuditAtRate(tx, { orgId, eventType: ROUTINE_EVENT })
        )
        // Force the window into the past directly (bypassing the gate) to simulate expiry
        // without a real sleep.
        await withOrg(orgId, (tx) =>
          tx.execute(
            sql`UPDATE audit_org_storage_usage SET rate_window_reset_at = now() - interval '1 second' WHERE org_id = ${orgId}`
          )
        )
        await withOrg(orgId, (tx) =>
          assertOrgMayWriteAuditAtRate(tx, { orgId, eventType: ROUTINE_EVENT })
        )
        const usage = await readUsage(orgId)
        expect(usage?.rateWindowCount).toBe(1)
      })
    })

    it('first-write guard (NF-20 regression): a fresh org with cap=1 and 2 concurrent writes admits exactly 1, never both', async () => {
      await withTestOrg(async ({ orgId }) => {
        await setRateCap(orgId, 1)
        const attempts = Array.from({ length: 2 }, () =>
          withOrg(orgId, (tx) =>
            assertOrgMayWriteAuditAtRate(tx, { orgId, eventType: ROUTINE_EVENT })
          )
        )
        const results = await Promise.allSettled(attempts)
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
        expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)
        const usage = await readUsage(orgId)
        expect(usage?.rateWindowCount).toBe(1)
      })
    })
  })

  describe('AC-6: exemption classes never rate-refuse, and the deadlock-prevention case', () => {
    it('a remediation event is admitted even over cap, and still increments rate_window_count', async () => {
      await withTestOrg(async ({ orgId }) => {
        await setRateCap(orgId, 1)
        await withOrg(orgId, (tx) =>
          assertOrgMayWriteAuditAtRate(tx, { orgId, eventType: ROUTINE_EVENT })
        )
        await withOrg(orgId, (tx) =>
          assertOrgMayWriteAuditAtRate(tx, {
            orgId,
            eventType: AuditEvent.AUDIT_QUOTA_CONFIGURED,
          })
        )
        const usage = await readUsage(orgId)
        expect(usage?.rateWindowCount).toBe(2)
      })
    })

    it('SESSION_CREATED (security_critical) is never rate-refused, closing the login deadlock', async () => {
      await withTestOrg(async ({ orgId }) => {
        await setRateCap(orgId, 1)
        await withOrg(orgId, (tx) =>
          assertOrgMayWriteAuditAtRate(tx, { orgId, eventType: ROUTINE_EVENT })
        )
        await expect(
          withOrg(orgId, (tx) =>
            assertOrgMayWriteAuditAtRate(tx, { orgId, eventType: AuditEvent.SESSION_CREATED })
          )
        ).resolves.toBeUndefined()
      })
    })

    it('preauth events never touch the enforced counter, and never refuse authenticated writes (AC-5 required test)', async () => {
      await withTestOrg(async ({ orgId }) => {
        await setRateCap(orgId, 1)
        for (let i = 0; i < 500; i++) {
          await withOrg(orgId, (tx) =>
            assertOrgMayWriteAuditAtRate(tx, { orgId, eventType: AuditEvent.LOGIN_FAILED })
          )
        }
        const usage = await readUsage(orgId)
        expect(usage?.preauthRateWindowCount).toBe(500)
        expect(usage?.rateWindowCount ?? 0).toBe(0)

        // The org's own authenticated write still succeeds — the preauth flood never refuses it.
        await withOrg(orgId, (tx) =>
          assertOrgMayWriteAuditAtRate(tx, { orgId, eventType: ROUTINE_EVENT })
        )
      })
    })

    it('deadlock-prevention: an org over BOTH storage and rate can still log in and remediate (AC-6 required dedicated test)', async () => {
      await withTestOrg(async ({ orgId }) => {
        await setRateCap(orgId, 1)
        await withOrg(orgId, (tx) =>
          assertOrgMayWriteAuditAtRate(tx, { orgId, eventType: ROUTINE_EVENT })
        )
        // Org is now at its rate cap. Login and remediation must both still succeed.
        await withOrg(orgId, (tx) =>
          assertOrgMayWriteAuditAtRate(tx, { orgId, eventType: AuditEvent.SESSION_CREATED })
        )
        await withOrg(orgId, (tx) =>
          assertOrgMayWriteAuditAtRate(tx, {
            orgId,
            eventType: AuditEvent.AUDIT_QUOTA_CONFIGURED,
          })
        )
        // A routine, non-exempt write is still correctly refused — exemption is scoped, not a
        // blanket "org is fine now" reset.
        await expect(
          withOrg(orgId, (tx) =>
            assertOrgMayWriteAuditAtRate(tx, { orgId, eventType: ROUTINE_EVENT })
          )
        ).rejects.toMatchObject({ code: 'audit_rate_limited' })
      })
    })

    it('classifyAuditWriteExemption is reused unmodified (no forked classification)', () => {
      expect(classifyAuditWriteExemption(AuditEvent.SESSION_CREATED)).toBe('security_critical')
      expect(classifyAuditWriteExemption(AuditEvent.LOGIN_FAILED)).toBe('preauth')
      expect(classifyAuditWriteExemption(AuditEvent.AUDIT_QUOTA_CONFIGURED)).toBe('remediation')
      expect(classifyAuditWriteExemption(ROUTINE_EVENT)).toBeNull()
    })
  })

  describe('AC-3: rate-cap precedence', () => {
    it('a per-org row with write_rate_per_minute = NULL falls back to the env default (OPPOSITE of quotaBytes semantics)', async () => {
      const previousDefault = process.env['AUDIT_ORG_DEFAULT_WRITE_RATE_PER_MIN']
      process.env['AUDIT_ORG_DEFAULT_WRITE_RATE_PER_MIN'] = '1'
      process.env['AUDIT_ORG_WRITE_RATE_ENFORCEMENT_ENABLED'] = 'true'
      vi.resetModules()
      try {
        const { assertOrgMayWriteAuditAtRate: assertWithDefault } = await import('./quota-gate.js')
        await withTestOrg(async ({ orgId }) => {
          await setRateCap(orgId, null)
          await withOrg(orgId, (tx) => assertWithDefault(tx, { orgId, eventType: ROUTINE_EVENT }))
          // The instance default is 1/window — a second write is refused.
          await expect(
            withOrg(orgId, (tx) => assertWithDefault(tx, { orgId, eventType: ROUTINE_EVENT }))
          ).rejects.toMatchObject({ code: 'audit_rate_limited' })
        })
      } finally {
        if (previousDefault === undefined)
          delete process.env['AUDIT_ORG_DEFAULT_WRITE_RATE_PER_MIN']
        else process.env['AUDIT_ORG_DEFAULT_WRITE_RATE_PER_MIN'] = previousDefault
        vi.resetModules()
      }
    })
  })

  describe('AC-3: the kill switch, independent of the storage gate', () => {
    it('with rate enforcement disabled, a write past a tiny configured cap is never refused', async () => {
      const previous = process.env['AUDIT_ORG_WRITE_RATE_ENFORCEMENT_ENABLED']
      process.env['AUDIT_ORG_WRITE_RATE_ENFORCEMENT_ENABLED'] = 'false'
      vi.resetModules()
      try {
        const { assertOrgMayWriteAuditAtRate: assertWithSwitchOff } =
          await import('./quota-gate.js')
        await withTestOrg(async ({ orgId }) => {
          await setRateCap(orgId, 1)
          for (let i = 0; i < 10; i++) {
            await expect(
              withOrg(orgId, (tx) => assertWithSwitchOff(tx, { orgId, eventType: ROUTINE_EVENT }))
            ).resolves.toBeUndefined()
          }
        })
      } finally {
        if (previous === undefined) delete process.env['AUDIT_ORG_WRITE_RATE_ENFORCEMENT_ENABLED']
        else process.env['AUDIT_ORG_WRITE_RATE_ENFORCEMENT_ENABLED'] = previous
        vi.resetModules()
      }
    })
  })

  describe('AC-15/AC-8: cross-org isolation', () => {
    it("org A's rate refusal never touches org B's counters or admits/refuses its writes", async () => {
      await withTwoTestOrgs(async ({ orgAId, orgBId }) => {
        await setRateCap(orgAId, 1)
        await withOrg(orgAId, (tx) =>
          assertOrgMayWriteAuditAtRate(tx, { orgId: orgAId, eventType: ROUTINE_EVENT })
        )
        await expect(
          withOrg(orgAId, (tx) =>
            assertOrgMayWriteAuditAtRate(tx, { orgId: orgAId, eventType: ROUTINE_EVENT })
          )
        ).rejects.toMatchObject({ code: 'audit_rate_limited' })

        for (let i = 0; i < 5; i++) {
          await withOrg(orgBId, (tx) =>
            assertOrgMayWriteAuditAtRate(tx, { orgId: orgBId, eventType: ROUTINE_EVENT })
          )
        }
        const usageB = await readUsage(orgBId)
        expect(usageB?.rateWindowCount).toBe(5)
      })
    })

    it('20 concurrent writes against a cap of 3 admit exactly 3, refuse 17, never exceed cap; org B unaffected', async () => {
      await withTwoTestOrgs(async ({ orgAId, orgBId }) => {
        await setRateCap(orgAId, 3)

        const attempts = Array.from({ length: 20 }, () =>
          withOrg(orgAId, (tx) =>
            assertOrgMayWriteAuditAtRate(tx, { orgId: orgAId, eventType: ROUTINE_EVENT })
          )
        )
        const results = await Promise.allSettled(attempts)
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3)
        expect(results.filter((r) => r.status === 'rejected')).toHaveLength(17)
        const usageA = await readUsage(orgAId)
        expect(usageA?.rateWindowCount).toBe(3)

        await withOrg(orgBId, (tx) =>
          assertOrgMayWriteAuditAtRate(tx, { orgId: orgBId, eventType: ROUTINE_EVENT })
        )
        const usageB = await readUsage(orgBId)
        expect(usageB?.rateWindowCount).toBe(1)
      })
    }, 20_000)
  })

  describe('AC-9: recordAuditRateRefusalBestEffort', () => {
    it('increments rate_refused_count/last_rate_refusal_at and returns a positive retryAfterSeconds', async () => {
      await withTestOrg(async ({ orgId }) => {
        await setRateCap(orgId, 1)
        await withOrg(orgId, (tx) =>
          assertOrgMayWriteAuditAtRate(tx, { orgId, eventType: ROUTINE_EVENT })
        )
        const result = await recordAuditRateRefusalBestEffort(orgId)
        expect(result).not.toBeNull()
        expect(result?.retryAfterSeconds).toBeGreaterThan(0)

        const usage = await readUsage(orgId)
        expect(usage?.rateRefusedCount).toBe(1)
        expect(usage?.lastRateRefusalAt).not.toBeNull()

        await recordAuditRateRefusalBestEffort(orgId)
        const usageAfterSecond = await readUsage(orgId)
        expect(usageAfterSecond?.rateRefusedCount).toBe(2)
      })
    })

    it('swallows a failed update (never throws) and returns null', async () => {
      const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
      try {
        const result = await recordAuditRateRefusalBestEffort('not-a-uuid')
        expect(result).toBeNull()
        expect(writeSpy).toHaveBeenCalled()
        const loggedLine = writeSpy.mock.calls
          .map((call) => String(call[0]))
          .find((line) => line.includes('refusal_record_failed') || line.includes('orgId'))
        expect(loggedLine).toBeDefined()
        const parsed = JSON.parse((loggedLine ?? '').trim())
        expect(parsed.level).toBe('warn')
        expect(parsed.orgId).toBe('not-a-uuid')
      } finally {
        writeSpy.mockRestore()
      }
    })

    it('returns null when the org has no usage row yet (no rate_window_reset_at to report)', async () => {
      await withTestOrg(async ({ orgId }) => {
        // No write has happened yet — no row exists.
        const result = await recordAuditRateRefusalBestEffort(orgId)
        expect(result).toBeNull()
      })
    })
  })

  describe('AC-4: gate-statement failure wraps as audit_gate_unavailable, never a silent allow', () => {
    const BROKEN_TX_ORG_ID = ['00000000', '0000', '4000', '8000', '000000000002'].join('-')

    it('a broken tx is wrapped in SameTransactionAuditWriteError with code audit_gate_unavailable', async () => {
      const brokenTx = {
        execute: vi.fn().mockRejectedValue(new Error('connection terminated unexpectedly')),
      } as unknown as Tx

      await expect(
        assertOrgMayWriteAuditAtRate(brokenTx, {
          orgId: BROKEN_TX_ORG_ID,
          eventType: ROUTINE_EVENT,
        })
      ).rejects.toMatchObject({ code: 'audit_gate_unavailable' })
    })
  })

  describe('AC-10: opt-in — the kill switch off issues ZERO statements, independent of the storage gate', () => {
    it('with the rate kill switch off, assertOrgMayWriteAuditAtRate issues zero tx.execute calls', async () => {
      const previous = process.env['AUDIT_ORG_WRITE_RATE_ENFORCEMENT_ENABLED']
      process.env['AUDIT_ORG_WRITE_RATE_ENFORCEMENT_ENABLED'] = 'false'
      vi.resetModules()
      try {
        const { assertOrgMayWriteAuditAtRate: assertWithSwitchOff } =
          await import('./quota-gate.js')
        const spyTx = { execute: vi.fn() } as unknown as Tx
        await assertWithSwitchOff(spyTx, { orgId: 'irrelevant', eventType: ROUTINE_EVENT })
        expect(spyTx.execute).not.toHaveBeenCalled()
      } finally {
        if (previous === undefined) delete process.env['AUDIT_ORG_WRITE_RATE_ENFORCEMENT_ENABLED']
        else process.env['AUDIT_ORG_WRITE_RATE_ENFORCEMENT_ENABLED'] = previous
        vi.resetModules()
      }
    })

    it('the two gates are independently gated: storage ON + rate OFF issues exactly one execute call (the storage gate), zero from the rate gate', async () => {
      const previousRate = process.env['AUDIT_ORG_WRITE_RATE_ENFORCEMENT_ENABLED']
      const previousQuota = process.env['AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED']
      process.env['AUDIT_ORG_WRITE_RATE_ENFORCEMENT_ENABLED'] = 'false'
      process.env['AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED'] = 'true'
      vi.resetModules()
      try {
        const { assertOrgMayWriteAuditAtRate: rateGate, assertOrgMayWriteAudit: storageGate } =
          await import('./quota-gate.js')
        await withTestOrg(async ({ orgId }) => {
          await withOrg(orgId, async (tx) => {
            const executeSpy = vi.spyOn(tx, 'execute')
            await rateGate(tx, { orgId, eventType: ROUTINE_EVENT })
            expect(executeSpy).not.toHaveBeenCalled()
            await storageGate(tx, { orgId, eventType: ROUTINE_EVENT, sizeBytes: 10 })
            expect(executeSpy).toHaveBeenCalledTimes(1)
          })
        })
      } finally {
        if (previousRate === undefined)
          delete process.env['AUDIT_ORG_WRITE_RATE_ENFORCEMENT_ENABLED']
        else process.env['AUDIT_ORG_WRITE_RATE_ENFORCEMENT_ENABLED'] = previousRate
        if (previousQuota === undefined) delete process.env['AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED']
        else process.env['AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED'] = previousQuota
        vi.resetModules()
      }
    })
  })

  describe('AC-4 red-team finding: orgId provenance', () => {
    it('assertOrgMayWriteAuditAtRate takes orgId as an explicit parameter, never reading it off request-shaped input', () => {
      // Static contract check: the function signature accepts only { orgId, eventType } — there
      // is no request/query/header parameter it could be threaded through. This is asserted at
      // every one of the nine call sites by grep review (Task 8) and by each site's own test
      // asserting the orgId argument equals the authenticated caller's own auth.orgId /
      // fields.orgId, never a request-supplied value (see human-entry.test.ts,
      // machine-entry.test.ts, service.test.ts, session-revoke.test.ts and friends, which already
      // assert exact orgId equality on every assertOrgMayWriteAudit/AtRate call).
      expect(assertOrgMayWriteAuditAtRate).toHaveLength(2)
    })
  })
})
