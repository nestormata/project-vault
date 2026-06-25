import { pgTable, uuid, timestamp } from 'drizzle-orm/pg-core'

// Not org-scoped: platform-level heartbeat table for the multi-instance guard. No RLS.
export const apiInstances = pgTable('api_instances', {
  id: uuid('id').primaryKey().defaultRandom(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeen: timestamp('last_seen', { withTimezone: true }).notNull().defaultNow(),
})
