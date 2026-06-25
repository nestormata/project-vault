import { pgTable, uuid, integer, timestamp, text } from 'drizzle-orm/pg-core'
import { orgScoped } from './helpers.js'
import { users } from './users.js'

// Intentionally partial: jti/revoked_at are added by Story 1.7. See Dev Notes.
export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  ...orgScoped({ onDelete: 'cascade' }),
  sessionVersion: integer('session_version').notNull().default(1),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastActiveAt: timestamp('last_active_at', { withTimezone: true }).notNull().defaultNow(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
