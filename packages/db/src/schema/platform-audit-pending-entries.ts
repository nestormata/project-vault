import { pgTable, uuid, jsonb, timestamp, bigint, index } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

/**
 * Story 9.4 D8: staging table for platform-audit writes attempted while the log itself is
 * unavailable AND maintenance mode is active. `sequenceNum` is drawn from a dedicated sequence
 * (`platform_audit_pending_seq`, migration-owned — not a Drizzle-managed serial column) so FIFO
 * drain order is guaranteed even under concurrent writers. No org_id/RLS: platform-level only.
 */
export const platformAuditPendingEntries = pgTable(
  'platform_audit_pending_entries',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    intendedFields: jsonb('intended_fields').notNull(),
    attemptedAt: timestamp('attempted_at', { withTimezone: true }).notNull().defaultNow(),
    sequenceNum: bigint('sequence_num', { mode: 'number' }).notNull(),
  },
  (t) => ({
    sequenceIdx: index('idx_platform_audit_pending_entries_sequence').on(t.sequenceNum),
  })
)

export type PlatformAuditPendingEntry = typeof platformAuditPendingEntries.$inferSelect
export type NewPlatformAuditPendingEntry = typeof platformAuditPendingEntries.$inferInsert
