import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import postgres from 'postgres'
import { withOrg } from '@project-vault/db'
import {
  auditLogEntries,
  auditOrgStorageUsage,
  auditStorageQuotaConfig,
} from '@project-vault/db/schema'
import { withTestOrg } from '@project-vault/db/test-helpers'
import { SUPERUSER_DATABASE_URL } from '../__tests__/db-urls.js'

// Story 1.25 AC-4 edge case: "confirm directly (do not assume) whether an over-quota org's
// retention purge would itself now fail to record its tombstone." This test proves the chosen
// resolution — (a) a quota-gate bypass for the system-authored purge-boundary event type,
// registered in QUOTA_REMEDIATION_EVENT_TYPES (quota-gate.ts) — actually works end to end,
// against a real over-quota org.
const keyDir = mkdtempSync(join(tmpdir(), 'audit-retention-prune-quota-gate-test-'))
process.env['DATABASE_URL'] ??=
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'
process.env['VAULT_KEY_DIR'] = keyDir
process.env['VAULT_ALLOW_REMOTE_INIT'] = 'true'
process.env['AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED'] = 'true'
process.env['AUDIT_ORG_WRITE_RATE_ENFORCEMENT_ENABLED'] = 'false'

const { initVault, zeroKeys, loadInitialVaultState } =
  await import('../modules/vault/key-service.js')
const { resetVaultForTest } = await import('../__tests__/helpers/vault-test-cleanup.js')
const { writeSystemAuditEntry } = await import('../modules/audit/machine-entry.js')
const { configureRetention } = await import('../modules/audit/retention.js')
const { pruneExpiredAuditLogEntries } = await import('./audit-retention-prune.js')

const TEST_PASSPHRASE = 'test-passphrase-quota-gate-tb'

async function setQuotaZero(orgId: string): Promise<void> {
  await withOrg(orgId, (tx) =>
    tx
      .insert(auditStorageQuotaConfig)
      .values({ orgId, quotaBytes: 1, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: auditStorageQuotaConfig.orgId,
        set: { quotaBytes: 1, updatedAt: new Date() },
      })
  )
  // Push the org's persisted usage counter comfortably over the 1-byte quota so every future
  // gated write (except an exempt one) is refused.
  await withOrg(orgId, (tx) =>
    tx
      .insert(auditOrgStorageUsage)
      .values({ orgId, bytesUsed: 10_000_000, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: auditOrgStorageUsage.orgId,
        set: { bytesUsed: 10_000_000, updatedAt: new Date() },
      })
  )
}

describe.sequential('Story 1.25 AC-4: retention-purge tombstone under an over-quota org', () => {
  beforeAll(async () => {
    await resetVaultForTest()
    zeroKeys()
    await loadInitialVaultState()
    await initVault({ kmsType: 'passphrase', passphrase: TEST_PASSPHRASE }, {})
  })

  afterAll(async () => {
    await resetVaultForTest()
    rmSync(keyDir, { recursive: true, force: true })
  })

  it('an over-quota org still gets its purge-boundary tombstone written (quota-gate bypass, not silently skipped)', async () => {
    await withTestOrg(async ({ orgId }) => {
      await withOrg(orgId, (tx) => configureRetention(tx, orgId, 30))

      // Two old rows (purged) written BEFORE the quota is exhausted, so the ordinary writes
      // themselves aren't what's under test here — only the tombstone write is. Uses withOrg
      // (not a bare getDb().transaction()) because assertOrgMayWriteAuditGates — called before
      // writeSystemAuditEntry's own set_config — needs the transaction's RLS org context already
      // set, exactly as SecureRoute already does for every real request in production.
      await withOrg(orgId, (tx) =>
        writeSystemAuditEntry(tx, { orgId, eventType: 'test.old1', payload: {} })
      )
      await withOrg(orgId, (tx) =>
        writeSystemAuditEntry(tx, { orgId, eventType: 'test.old2', payload: {} })
      )
      // A recent row that survives the purge — without it, the org's entire history would be
      // purged (the "full-history-wipe" case, AC-4's OTHER negative example), which correctly
      // skips the tombstone for a different reason and would not exercise the quota-gate bypass
      // this test targets.
      await withOrg(orgId, (tx) =>
        writeSystemAuditEntry(tx, { orgId, eventType: 'test.new', payload: {} })
      )
      await backdateOldRows(orgId)

      // Now push the org over quota — a NON-exempt write for this org would be refused from here on.
      await setQuotaZero(orgId)

      await expect(pruneExpiredAuditLogEntries()).resolves.toBeUndefined()

      const remaining = await withOrg(orgId, (tx) =>
        tx
          .select({ eventType: auditLogEntries.eventType })
          .from(auditLogEntries)
          .where(eq(auditLogEntries.orgId, orgId))
          .orderBy(auditLogEntries.chainSeq)
      )
      // The tombstone was written despite the org being over quota — proof the bypass works.
      expect(remaining.map((r) => r.eventType)).toEqual([
        'test.new',
        'audit.retention_purge_boundary',
      ])
    })
  })
})

async function backdateOldRows(orgId: string): Promise<void> {
  const adminSql = postgres(SUPERUSER_DATABASE_URL)
  try {
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()
    await adminSql.begin(async (tx) => {
      await tx`ALTER TABLE audit_log_entries DISABLE TRIGGER audit_log_immutability`
      await tx`
        UPDATE audit_log_entries SET created_at = ${oldDate}::timestamptz
         WHERE org_id = ${orgId} AND event_type IN ('test.old1', 'test.old2')
      `
      await tx`ALTER TABLE audit_log_entries ENABLE TRIGGER audit_log_immutability`
    })
  } finally {
    await adminSql.end()
  }
}
