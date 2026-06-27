import { sql } from 'drizzle-orm'
import {
  check,
  index,
  inet,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { organizations } from './organizations.js'
import { users } from './users.js'

// Identity-scoped pending login table. org_id is stored for session issuance; no RLS by design.
export const pendingMfaSessions = pgTable(
  'pending_mfa_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    attemptCount: integer('attempt_count').notNull().default(0),
    ipAddress: inet('ip_address'),
    userAgent: text('user_agent'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tokenHashCheck: check(
      'pending_mfa_sessions_token_hash_check',
      sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`
    ),
    attemptCountCheck: check(
      'pending_mfa_sessions_attempt_count_check',
      sql`${t.attemptCount} >= 0`
    ),
    expiresAfterCreatedCheck: check(
      'pending_mfa_sessions_expires_after_created_check',
      sql`${t.expiresAt} > ${t.createdAt}`
    ),
    tokenHashIdx: uniqueIndex('idx_pending_mfa_sessions_token_hash').on(t.tokenHash),
    expiresAtIdx: index('idx_pending_mfa_sessions_expires_at').on(t.expiresAt),
    userIdIdx: index('idx_pending_mfa_sessions_user_id').on(t.userId),
    userOrgIdx: uniqueIndex('idx_pending_mfa_sessions_user_org').on(t.userId, t.orgId),
  })
)

export type PendingMfaSession = typeof pendingMfaSessions.$inferSelect
export type NewPendingMfaSession = typeof pendingMfaSessions.$inferInsert
