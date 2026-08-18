import { beforeAll, describe, expect, it, vi } from 'vitest'
import { eq, and, sql } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { auditLogEntries, platformAuditEvents } from '@project-vault/db/schema'
import { AuditEvent, PlatformAuditAction } from '@project-vault/shared'

process.env['DATABASE_URL'] ??=
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'
process.env['VAULT_ALLOW_REMOTE_INIT'] = 'true'
process.env['AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED'] = 'true'

const { initVault } = await import('../vault/key-service.js')
const { resetVaultForTest } = await import('../../__tests__/helpers/vault-test-cleanup.js')
const { withTestOrg, createTestUser } = await import('@project-vault/db/test-helpers')
const { setOrgAuditQuota, resolveEffectiveOrgQuotaBytes } = await import('./quota-config.js')
const { assertOrgMayWriteAudit } = await import('./quota-gate.js')
const { getDb } = await import('@project-vault/db')

const OPERATOR_LABEL = 'quota-config-operator'
const ROUTINE_EVENT = 'credential.value_revealed'

describe.sequential('Story 22.1 AC-5: setOrgAuditQuota dual-write', () => {
  beforeAll(async () => {
    await resetVaultForTest()
    try {
      await initVault({ kmsType: 'passphrase', passphrase: 'quota-config-test-passphrase' }, {})
    } catch (error) {
      if ((error as { code?: string }).code !== 'ALREADY_INITIALIZED') throw error
    }
  })

  it('records the change in both the org log (audit.quota_configured, exempt from refusal) and the platform log, in one transaction', async () => {
    await withTestOrg(async ({ orgId }) => {
      const operatorId = await createTestUser(OPERATOR_LABEL)
      await getDb().transaction((tx) =>
        setOrgAuditQuota(tx as never, {
          orgId,
          quotaBytes: 1_073_741_824,
          operatorId,
        })
      )

      const orgRows = await withOrg(orgId, (tx) =>
        tx
          .select()
          .from(auditLogEntries)
          .where(
            and(
              eq(auditLogEntries.orgId, orgId),
              eq(auditLogEntries.eventType, AuditEvent.AUDIT_QUOTA_CONFIGURED)
            )
          )
      )
      expect(orgRows).toHaveLength(1)
      expect(orgRows[0]?.payload).toMatchObject({
        previous: { quotaBytes: null },
        next: { quotaBytes: 1_073_741_824 },
      })

      const platformRows = await getDb().transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.platform_operator_verified', 'true', true)`)
        return tx
          .select()
          .from(platformAuditEvents)
          .where(
            and(
              eq(platformAuditEvents.targetOrgId, orgId),
              eq(platformAuditEvents.actionType, PlatformAuditAction.AUDIT_QUOTA_CONFIGURED)
            )
          )
      })
      expect(platformRows).toHaveLength(1)

      const effective = await withOrg(orgId, (tx) => resolveEffectiveOrgQuotaBytes(tx, orgId))
      expect(effective).toBe(1_073_741_824)
    })
  })

  // AC-11's deadlock-prevention case: an over-quota org must still be able to have its own quota
  // raised — this is exactly why audit.quota_configured is a QUOTA_REMEDIATION_EVENT_TYPES member,
  // not merely tested by classification in quota-gate.test.ts but exercised here end to end
  // through the real dual-write path.
  it('can raise a fully-exhausted org back out of refusal (AC-30 #6)', async () => {
    await withTestOrg(async ({ orgId }) => {
      // Exhaust the org at a 1-byte quota.
      const exhaustingOperatorId = await createTestUser(OPERATOR_LABEL)
      await getDb().transaction((tx) =>
        setOrgAuditQuota(tx as never, { orgId, quotaBytes: 1, operatorId: exhaustingOperatorId })
      )
      await expect(
        withOrg(orgId, (tx) =>
          assertOrgMayWriteAudit(tx, {
            orgId,
            eventType: ROUTINE_EVENT,
            sizeBytes: 999,
          })
        )
      ).rejects.toMatchObject({ code: 'audit_quota_exhausted' })

      // Raising the quota is itself a QUOTA_REMEDIATION_EVENT_TYPES write and must succeed even
      // though the org is currently over quota.
      const raisingOperatorId = await createTestUser(OPERATOR_LABEL)
      await getDb().transaction((tx) =>
        setOrgAuditQuota(tx as never, {
          orgId,
          quotaBytes: 1_000_000,
          operatorId: raisingOperatorId,
        })
      )

      // The org can now write normally again.
      await withOrg(orgId, (tx) =>
        assertOrgMayWriteAudit(tx, {
          orgId,
          eventType: ROUTINE_EVENT,
          sizeBytes: 999,
        })
      )
    })
  })

  // Story 22.2 AC-13: setOrgAuditQuota() extended to carry writeRatePerMinute alongside
  // quotaBytes — a rate-only change, a quota-only change, and a combined change, each a single
  // dual-write audit trail (not a second event type, not a second parallel function).
  describe('Story 22.2 AC-13: setOrgAuditQuota carries writeRatePerMinute', () => {
    it('a rate-only change leaves quotaBytes untouched and records both fields in one audit.quota_configured payload', async () => {
      await withTestOrg(async ({ orgId }) => {
        const operatorId = await createTestUser(OPERATOR_LABEL)
        await getDb().transaction((tx) =>
          setOrgAuditQuota(tx as never, { orgId, quotaBytes: 500_000, operatorId })
        )

        const rateOperatorId = await createTestUser(OPERATOR_LABEL)
        await getDb().transaction((tx) =>
          setOrgAuditQuota(tx as never, {
            orgId,
            writeRatePerMinute: 2000,
            operatorId: rateOperatorId,
          })
        )

        const orgRows = await withOrg(orgId, (tx) =>
          tx
            .select()
            .from(auditLogEntries)
            .where(
              and(
                eq(auditLogEntries.orgId, orgId),
                eq(auditLogEntries.eventType, AuditEvent.AUDIT_QUOTA_CONFIGURED)
              )
            )
        )
        expect(orgRows).toHaveLength(2)
        expect(orgRows[1]?.payload).toMatchObject({
          previous: { quotaBytes: 500_000, writeRatePerMinute: null },
          next: { quotaBytes: 500_000, writeRatePerMinute: 2000 },
        })
      })
    })

    it('a quota-only change leaves writeRatePerMinute untouched', async () => {
      await withTestOrg(async ({ orgId }) => {
        const rateOperatorId = await createTestUser(OPERATOR_LABEL)
        await getDb().transaction((tx) =>
          setOrgAuditQuota(tx as never, {
            orgId,
            writeRatePerMinute: 1500,
            operatorId: rateOperatorId,
          })
        )
        const quotaOperatorId = await createTestUser(OPERATOR_LABEL)
        await getDb().transaction((tx) =>
          setOrgAuditQuota(tx as never, {
            orgId,
            quotaBytes: 10_000_000,
            operatorId: quotaOperatorId,
          })
        )

        const orgRows = await withOrg(orgId, (tx) =>
          tx
            .select()
            .from(auditLogEntries)
            .where(
              and(
                eq(auditLogEntries.orgId, orgId),
                eq(auditLogEntries.eventType, AuditEvent.AUDIT_QUOTA_CONFIGURED)
              )
            )
        )
        expect(orgRows[1]?.payload).toMatchObject({
          next: { quotaBytes: 10_000_000, writeRatePerMinute: 1500 },
        })
      })
    })

    it('a combined change (both fields at once) records both in a single audit.quota_configured entry', async () => {
      await withTestOrg(async ({ orgId }) => {
        const operatorId = await createTestUser(OPERATOR_LABEL)
        await getDb().transaction((tx) =>
          setOrgAuditQuota(tx as never, {
            orgId,
            quotaBytes: 999_999,
            writeRatePerMinute: 750,
            operatorId,
          })
        )

        const orgRows = await withOrg(orgId, (tx) =>
          tx
            .select()
            .from(auditLogEntries)
            .where(
              and(
                eq(auditLogEntries.orgId, orgId),
                eq(auditLogEntries.eventType, AuditEvent.AUDIT_QUOTA_CONFIGURED)
              )
            )
        )
        expect(orgRows).toHaveLength(1)
        expect(orgRows[0]?.payload).toMatchObject({
          previous: { quotaBytes: null, writeRatePerMinute: null },
          next: { quotaBytes: 999_999, writeRatePerMinute: 750 },
        })

        const platformRows = await getDb().transaction(async (tx) => {
          await tx.execute(sql`SELECT set_config('app.platform_operator_verified', 'true', true)`)
          return tx
            .select()
            .from(platformAuditEvents)
            .where(
              and(
                eq(platformAuditEvents.targetOrgId, orgId),
                eq(platformAuditEvents.actionType, PlatformAuditAction.AUDIT_QUOTA_CONFIGURED)
              )
            )
        })
        expect(platformRows).toHaveLength(1)
      })
    })

    it('audit.quota_configured remains remediation-exempt for the rate axis too — an org over its rate cap can still have its cap raised', async () => {
      await withTestOrg(async ({ orgId }) => {
        const previousRate = process.env['AUDIT_ORG_WRITE_RATE_ENFORCEMENT_ENABLED']
        process.env['AUDIT_ORG_WRITE_RATE_ENFORCEMENT_ENABLED'] = 'true'
        vi.resetModules()
        try {
          const { assertOrgMayWriteAuditAtRate } = await import('./quota-gate.js')
          const exhaustingOperatorId = await createTestUser(OPERATOR_LABEL)
          await getDb().transaction((tx) =>
            setOrgAuditQuota(tx as never, {
              orgId,
              writeRatePerMinute: 1,
              operatorId: exhaustingOperatorId,
            })
          )
          await withOrg(orgId, (tx) =>
            assertOrgMayWriteAuditAtRate(tx, { orgId, eventType: ROUTINE_EVENT })
          )
          await expect(
            withOrg(orgId, (tx) =>
              assertOrgMayWriteAuditAtRate(tx, { orgId, eventType: ROUTINE_EVENT })
            )
          ).rejects.toMatchObject({ code: 'audit_rate_limited' })

          // Raising the rate cap is itself a QUOTA_REMEDIATION_EVENT_TYPES write (via the shared
          // audit.quota_configured event type) and must succeed even though the org is over its
          // own rate cap right now.
          const raisingOperatorId = await createTestUser(OPERATOR_LABEL)
          await getDb().transaction((tx) =>
            setOrgAuditQuota(tx as never, {
              orgId,
              writeRatePerMinute: 100_000,
              operatorId: raisingOperatorId,
            })
          )
        } finally {
          if (previousRate === undefined)
            delete process.env['AUDIT_ORG_WRITE_RATE_ENFORCEMENT_ENABLED']
          else process.env['AUDIT_ORG_WRITE_RATE_ENFORCEMENT_ENABLED'] = previousRate
          vi.resetModules()
        }
      })
    })
  })
})
