// SINGLE ROW TABLE: platform-level state; no org_id; no RLS; exempt from check-rls-coverage
import { pgTable, smallint, boolean, text, uuid, timestamp, check } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { users } from './users.js'

/**
 * Story 9.4 D8: single-row (id=1) maintenance-mode flag for the platform audit log's
 * write-failure-bypass mechanism — mirrors `vault_state`'s single-row convention.
 */
export const platformAuditMaintenanceState = pgTable(
  'platform_audit_maintenance_state',
  {
    id: smallint('id')
      .primaryKey()
      .default(sql`1`),
    active: boolean('active').notNull().default(false),
    reason: text('reason'),
    activatedByUserId: uuid('activated_by_user_id').references(() => users.id),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
  },
  (table) => [check('platform_audit_maintenance_state_single_row', sql`${table.id} = 1`)]
)

export type PlatformAuditMaintenanceState = typeof platformAuditMaintenanceState.$inferSelect
export type NewPlatformAuditMaintenanceState = typeof platformAuditMaintenanceState.$inferInsert
