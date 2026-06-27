import { pgTable, uuid, integer, timestamp, text, index } from 'drizzle-orm/pg-core'
import { orgScoped } from './helpers.js'
import { users } from './users.js'

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    ...orgScoped({ onDelete: 'cascade' }),
    jti: text('jti').unique(),
    sessionVersion: integer('session_version').notNull().default(1),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }).notNull().defaultNow(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    expiresAtIdx: index('idx_sessions_expires_at').on(t.expiresAt),
    userIdIdx: index('idx_sessions_user_id').on(t.userId),
  })
)
