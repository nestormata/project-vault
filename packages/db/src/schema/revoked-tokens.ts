import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { users } from './users.js'

// Identity-scoped JWT revocation cache. It intentionally has no org_id and no RLS policy.
export const revokedTokens = pgTable(
  'revoked_tokens',
  {
    jti: text('jti').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    expiresAtIdx: index('idx_revoked_tokens_expires_at').on(t.expiresAt),
    userIdIdx: index('idx_revoked_tokens_user_id').on(t.userId),
  })
)

export type RevokedToken = typeof revokedTokens.$inferSelect
export type NewRevokedToken = typeof revokedTokens.$inferInsert
