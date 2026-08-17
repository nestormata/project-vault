import { pgTable, uuid, bigint, timestamp, check } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { organizations } from './organizations.js'

/**
 * Story 22.1 AC-2 — one row per org. `quotaBytes: null` (the default — no row at all is
 * equivalent) means "no limit for this org", mirroring `audit_retention_config.retentionDays`'s
 * `NULL = retain forever` convention. Quota is denominated in LOGICAL bytes (AC-27):
 * `sum(pg_column_size(t.*))` over the org's `audit_log_entries` rows — the same unit the
 * incremental usage counter accumulates. No `write_rate_per_minute` column: per-org write-rate
 * limiting was removed from this story in the second-pass revision and deferred to Story 22.2.
 */
export const auditStorageQuotaConfig = pgTable(
  'audit_storage_quota_config',
  {
    orgId: uuid('org_id')
      .primaryKey()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    quotaBytes: bigint('quota_bytes', { mode: 'number' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('audit_storage_quota_config_quota_bytes_positive', sql`${table.quotaBytes} > 0`),
  ]
)

export type AuditStorageQuotaConfig = typeof auditStorageQuotaConfig.$inferSelect
export type NewAuditStorageQuotaConfig = typeof auditStorageQuotaConfig.$inferInsert
