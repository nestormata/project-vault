import { pgTable, uuid, text, timestamp, check, uniqueIndex } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { orgScoped } from './helpers.js'

export const orgNotificationRouting = pgTable(
  'org_notification_routing',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...orgScoped({ onDelete: 'cascade' }),
    alertType: text('alert_type').notNull(),
    routeTo: text('route_to').notNull().default('owner'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    routeToCheck: check(
      'org_notification_routing_route_to_check',
      sql`${t.routeTo} IN ('owner','admin','member')`
    ),
    uniqueRouting: uniqueIndex('uq_org_notification_routing').on(t.orgId, t.alertType),
  })
)
