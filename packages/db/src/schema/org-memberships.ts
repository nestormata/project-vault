import { pgTable, uuid, text, timestamp, primaryKey, check } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { orgScoped } from './helpers.js'
import { users } from './users.js'

export const orgMemberships = pgTable(
  'org_memberships',
  {
    ...orgScoped({ onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    status: text('status').notNull().default('active'),
    gracePeriodExpiresAt: timestamp('grace_period_expires_at', { withTimezone: true }),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.userId] }),
    roleCheck: check(
      'org_memberships_role_check',
      sql`${t.role} IN ('owner','admin','member','viewer')`
    ),
    statusCheck: check(
      'org_memberships_status_check',
      sql`${t.status} IN ('active','deactivated')`
    ),
  })
)
