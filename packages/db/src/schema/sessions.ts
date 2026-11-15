import {
  pgTable,
  uuid,
  integer,
  timestamp,
  text,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
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
    jti: text('jti').notNull(),
    sessionVersion: integer('session_version').notNull().default(1),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }).notNull().defaultNow(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    // Story 73.3: optional CM handoff display sidecar. Null for native login.
    handoffDisplayClaims: jsonb('handoff_display_claims').$type<{
      organizationName?: string
      tier?: string
      role?: string
    } | null>(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    expiresAtIdx: index('idx_sessions_expires_at').on(t.expiresAt),
    jtiIdx: uniqueIndex('idx_sessions_jti').on(t.jti),
    userIdIdx: index('idx_sessions_user_id').on(t.userId),
    lastActiveAtIdx: index('idx_sessions_last_active_at').on(t.lastActiveAt),
  })
)
