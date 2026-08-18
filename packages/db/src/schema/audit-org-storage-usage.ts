import { pgTable, uuid, bigint, timestamp, check } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { organizations } from './organizations.js'

/**
 * Story 22.1 AC-6 — the single per-org enforcement-state row. `bytesUsed` is the ENFORCED budget
 * (authenticated-origin audit volume, logical bytes, AC-27); `preauthBytesUsed` is recorded but is
 * never an input to any refusal decision (AC-29). `updatedAt DEFAULT now()`, matching
 * `audit_storage_quota_config` exactly (a gratuitous mismatch would break the upsert's INSERT arm
 * — review finding L1). `fillfactor = 70` is set in the migration (a non-default storage param,
 * not expressible via drizzle-kit's table builder) to favour HOT updates on this hot row.
 */
export const auditOrgStorageUsage = pgTable(
  'audit_org_storage_usage',
  {
    orgId: uuid('org_id')
      .primaryKey()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    bytesUsed: bigint('bytes_used', { mode: 'number' }).notNull().default(0),
    preauthBytesUsed: bigint('preauth_bytes_used', { mode: 'number' }).notNull().default(0),
    entryCount: bigint('entry_count', { mode: 'number' }).notNull().default(0),
    refusedWriteCount: bigint('refused_write_count', { mode: 'number' }).notNull().default(0),
    lastRefusalAt: timestamp('last_refusal_at', { withTimezone: true }),
    lastReconciledAt: timestamp('last_reconciled_at', { withTimezone: true }),
    // Story 22.2 AC-2 — colocated rate-window state (throughput axis), on the same RLS-protected
    // row rather than a new table (see quota-gate.ts's assertOrgMayWriteAuditAtRate() for why).
    // rateWindowCount is the ENFORCED, non-exempt/non-preauth authenticated-origin write count in
    // the current fixed window; preauthRateWindowCount mirrors preauthBytesUsed — recorded, never
    // an input to any refusal decision.
    rateWindowCount: bigint('rate_window_count', { mode: 'number' }).notNull().default(0),
    rateWindowResetAt: timestamp('rate_window_reset_at', { withTimezone: true }),
    preauthRateWindowCount: bigint('preauth_rate_window_count', { mode: 'number' })
      .notNull()
      .default(0),
    preauthRateWindowResetAt: timestamp('preauth_rate_window_reset_at', { withTimezone: true }),
    rateRefusedCount: bigint('rate_refused_count', { mode: 'number' }).notNull().default(0),
    lastRateRefusalAt: timestamp('last_rate_refusal_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('audit_org_storage_usage_bytes_used_non_negative', sql`${table.bytesUsed} >= 0`),
    check(
      'audit_org_storage_usage_preauth_bytes_used_non_negative',
      sql`${table.preauthBytesUsed} >= 0`
    ),
    check('audit_org_storage_usage_entry_count_non_negative', sql`${table.entryCount} >= 0`),
    check(
      'audit_org_storage_usage_rate_window_count_non_negative',
      sql`${table.rateWindowCount} >= 0`
    ),
    check(
      'audit_org_storage_usage_preauth_rate_window_count_non_negative',
      sql`${table.preauthRateWindowCount} >= 0`
    ),
  ]
)

export type AuditOrgStorageUsage = typeof auditOrgStorageUsage.$inferSelect
export type NewAuditOrgStorageUsage = typeof auditOrgStorageUsage.$inferInsert
