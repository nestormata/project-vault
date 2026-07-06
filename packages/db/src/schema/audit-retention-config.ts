import { pgTable, uuid, integer, timestamp } from 'drizzle-orm/pg-core'
import { organizations } from './organizations.js'

/**
 * One row per org (D7). `orgId` is the primary key — `PUT /audit/retention` upserts it.
 * `retentionDays: null` (the default — no row at all is equivalent) means "retain forever, no
 * automatic pruning" — an explicit, never-silently-assumed state.
 */
export const auditRetentionConfig = pgTable('audit_retention_config', {
  orgId: uuid('org_id')
    .primaryKey()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  retentionDays: integer('retention_days'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export type AuditRetentionConfig = typeof auditRetentionConfig.$inferSelect
export type NewAuditRetentionConfig = typeof auditRetentionConfig.$inferInsert
