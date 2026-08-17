import { describe, expect, it } from 'vitest'
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

describe.sequential('Story 22.1 AC-5: setOrgAuditQuota dual-write', () => {
  it('boots the vault once', async () => {
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
            eventType: 'credential.value_revealed',
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
          eventType: 'credential.value_revealed',
          sizeBytes: 999,
        })
      )
    })
  })
})
