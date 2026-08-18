import { pgTable, uuid, bigint, timestamp, check } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { organizations } from './organizations.js'

/**
 * Story 22.1 AC-2 — one row per org. `quotaBytes: null` (the default — no row at all is
 * equivalent) means "no limit for this org", mirroring `audit_retention_config.retentionDays`'s
 * `NULL = retain forever` convention. Quota is denominated in LOGICAL bytes (AC-27):
 * `sum(pg_column_size(t.*))` over the org's `audit_log_entries` rows — the same unit the
 * incremental usage counter accumulates. `write_rate_per_minute` (Story 22.2) is a second,
 * independent per-org override on the same row.
 */
export const auditStorageQuotaConfig = pgTable(
  'audit_storage_quota_config',
  {
    orgId: uuid('org_id')
      .primaryKey()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    quotaBytes: bigint('quota_bytes', { mode: 'number' }),
    // Story 22.2 AC-2/AC-3 — per-org write-rate cap override. NULL = no per-org override, fall
    // back to the instance default (AUDIT_ORG_DEFAULT_WRITE_RATE_PER_MIN) — the OPPOSITE of
    // quotaBytes' NULL-on-an-existing-row convention (there, NULL means unlimited for that org).
    // See AC-3's edge case for the reconciliation of the two conventions.
    writeRatePerMinute: bigint('write_rate_per_minute', { mode: 'number' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('audit_storage_quota_config_quota_bytes_positive', sql`${table.quotaBytes} > 0`),
    check(
      'audit_storage_quota_config_write_rate_per_minute_positive',
      sql`${table.writeRatePerMinute} > 0`
    ),
  ]
)

export type AuditStorageQuotaConfig = typeof auditStorageQuotaConfig.$inferSelect
export type NewAuditStorageQuotaConfig = typeof auditStorageQuotaConfig.$inferInsert
