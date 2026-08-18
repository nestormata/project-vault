import { beforeAll, describe, expect, it } from 'vitest'
import { eq, and, sql } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import {
  auditLogEntries,
  auditStorageQuotaConfig,
  auditOrgStorageUsage,
} from '@project-vault/db/schema'

process.env['DATABASE_URL'] ??=
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'
process.env['VAULT_ALLOW_REMOTE_INIT'] = 'true'
process.env['AUDIT_ORG_WRITE_RATE_ENFORCEMENT_ENABLED'] = 'true'
process.env['AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED'] = 'false'

const { initVault } = await import('../vault/key-service.js')
const { resetVaultForTest } = await import('../../__tests__/helpers/vault-test-cleanup.js')
const { withTestOrg } = await import('@project-vault/db/test-helpers')
const { writeHumanAuditEntry } = await import('./human-entry.js')
const { getDb } = await import('@project-vault/db')

const ROUTINE_EVENT = 'credential.value_revealed'

// Story 22.2 AC-5's pre-mortem edge case: a single request/transaction that writes MORE THAN ONE
// audit_log_entries row. If the org is near its rate cap, the FIRST write in that transaction can
// succeed while the SECOND is refused — and because both share the same outer transaction, the
// refusal rolls back the WHOLE request, including the first write's own audit row. This is
// expected/correct fail-closed behavior (mirrors Story 22.1's AC-9 for storage), not a bug.
describe('Story 22.2 AC-5 pre-mortem: multi-audit-write-per-transaction rollback', () => {
  beforeAll(async () => {
    await resetVaultForTest()
    try {
      await initVault({ kmsType: 'passphrase', passphrase: 'rate-gate-rollback-test' }, {})
    } catch (error) {
      if ((error as { code?: string }).code !== 'ALREADY_INITIALIZED') throw error
    }
  })

  it('a transaction writing two audit rows, refused on the second, leaves NEITHER row committed', async () => {
    await withTestOrg(async ({ orgId }) => {
      await withOrg(orgId, (tx) =>
        tx
          .insert(auditStorageQuotaConfig)
          .values({ orgId, writeRatePerMinute: 1, updatedAt: new Date() })
      )

      await expect(
        getDb().transaction(async (tx) => {
          // Mirrors secure-route.ts's setRlsOrgContext(), which normally runs once at the top of
          // the request's transaction before any audit writer is reached.
          await tx.execute(sql`SELECT set_config('app.current_org_id', ${orgId}, true)`)

          await writeHumanAuditEntry(tx as never, {
            orgId,
            actorTokenId: null,
            eventType: ROUTINE_EVENT,
            payload: { first: true },
          })
          // Second write in the SAME transaction: the org is now at its rate cap (1/window), so
          // this one is refused — and the whole outer transaction must roll back, including the
          // first write above.
          await writeHumanAuditEntry(tx as never, {
            orgId,
            actorTokenId: null,
            eventType: ROUTINE_EVENT,
            payload: { second: true },
          })
        })
      ).rejects.toMatchObject({ code: 'audit_rate_limited' })

      const rows = await withOrg(orgId, (tx) =>
        tx
          .select()
          .from(auditLogEntries)
          .where(
            and(eq(auditLogEntries.orgId, orgId), eq(auditLogEntries.eventType, ROUTINE_EVENT))
          )
      )
      expect(rows).toHaveLength(0)

      // The rate-window counter itself must also reflect the rollback: the gate statement's own
      // increment for the first write never survives, because it ran inside the same rolled-back
      // transaction as the refusing second call.
      const [usage] = await withOrg(orgId, (tx) =>
        tx
          .select({ rateWindowCount: auditOrgStorageUsage.rateWindowCount })
          .from(auditOrgStorageUsage)
          .where(eq(auditOrgStorageUsage.orgId, orgId))
      )
      expect(usage).toBeUndefined()
    })
  })
})
