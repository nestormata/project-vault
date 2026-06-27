import { sql } from 'drizzle-orm'
import { check, index, inet, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { users } from './users.js'

// Platform-scoped failed authentication telemetry. No org_id/RLS by design:
// org ownership is derived later by threshold workers when an alert is created.
export const failedAuthAttempts = pgTable(
  'failed_auth_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    ipAddress: inet('ip_address').notNull(),
    attemptedEmail: text('attempted_email').notNull(),
    reason: text('reason').notNull(),
    attemptedAt: timestamp('attempted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    reasonCheck: check(
      'failed_auth_attempts_reason_check',
      sql`${t.reason} IN ('invalid_credentials','invalid_totp','invalid_recovery_code','expired_recovery_code')`
    ),
    ipTimeIdx: index('idx_failed_auth_attempts_ip_time').on(t.ipAddress, t.attemptedAt.desc()),
    userTimeIdx: index('idx_failed_auth_attempts_user_time')
      .on(t.userId, t.attemptedAt.desc())
      .where(sql`${t.userId} IS NOT NULL`),
    emailTimeIdx: index('idx_failed_auth_attempts_email_time').on(
      sql`lower(${t.attemptedEmail})`,
      t.attemptedAt.desc()
    ),
    pruneIdx: index('idx_failed_auth_attempts_prune').on(t.attemptedAt),
  })
)

export type FailedAuthAttempt = typeof failedAuthAttempts.$inferSelect
export type NewFailedAuthAttempt = typeof failedAuthAttempts.$inferInsert
