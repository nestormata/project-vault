import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, integer, timestamp, index, check, unique } from 'drizzle-orm/pg-core'
import { orgScoped } from './helpers.js'
import { statusPages } from './status-pages.js'
import { serviceEndpoints } from './service-endpoints.js'

// Story 6.3 (ADR-6.3-02/04, realigned): `serviceId` references `service_endpoints.id` directly —
// NOT `payment_records.id` (the original, pre-6.2 draft's assumption). ON DELETE CASCADE means a
// service_endpoints row deleted via 6.2's own DELETE route automatically removes the reference
// here too — no dangling "ineligible but still referenced" state to handle at read time.
export const statusPageServices = pgTable(
  'status_page_services',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...orgScoped({ onDelete: 'cascade' }),
    statusPageId: uuid('status_page_id')
      .notNull()
      .references(() => statusPages.id, { onDelete: 'cascade' }),
    serviceId: uuid('service_id')
      .notNull()
      .references(() => serviceEndpoints.id, { onDelete: 'cascade' }),
    displayName: text('display_name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index('idx_status_page_services_org').on(t.orgId),
    statusPageIdx: index('idx_status_page_services_status_page_id').on(t.statusPageId),
    statusPageServiceUnique: unique('status_page_services_status_page_id_service_id_unique').on(
      t.statusPageId,
      t.serviceId
    ),
    displayNameLenCheck: check(
      'status_page_services_display_name_len_check',
      sql`char_length(${t.displayName}) BETWEEN 1 AND 100`
    ),
  })
)

export type StatusPageService = typeof statusPageServices.$inferSelect
export type NewStatusPageService = typeof statusPageServices.$inferInsert
