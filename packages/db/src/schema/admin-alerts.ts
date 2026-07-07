import { pgTable, uuid, text, jsonb, timestamp, check, index } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

/**
 * Story 9.1 D3 — a new platform-level (non-org-scoped, RLS-exempt) alert table, distinct from the
 * org-scoped `monitoring_alerts`/`security_alerts`. Used here for `backup.missed`/
 * `backup.failure`, and explicitly reserved for Story 9.2's FR109 key-custody-risk alert to reuse
 * — 9.2 must NOT invent a second, competing platform-alert table.
 */
export const adminAlerts = pgTable(
  'admin_alerts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    alertType: text('alert_type').notNull(), // 'backup.missed' | 'backup.failure' | (9.2 adds 'key_custody_risk')
    severity: text('severity').notNull(),
    payload: jsonb('payload').notNull().default({}),
    status: text('status').notNull().default('active'), // active | acknowledged | dismissed
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
  },
  (t) => [
    check('admin_alerts_severity_check', sql`${t.severity} IN ('info','warning','critical')`),
    check('admin_alerts_status_check', sql`${t.status} IN ('active','acknowledged','dismissed')`),
    // AC-12 idempotency check: "is there already an active alert of this type" lookup.
    index('idx_admin_alerts_type_status').on(t.alertType, t.status),
  ]
)
export type AdminAlert = typeof adminAlerts.$inferSelect
export type NewAdminAlert = typeof adminAlerts.$inferInsert
