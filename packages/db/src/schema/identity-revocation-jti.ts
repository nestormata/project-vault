import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * Story 73.4 D5: insert-first replay-burn ledger for trusted-caller identity session
 * revocation JWTs. The primary key on `jti` is the replay decision. No org_id and no RLS:
 * the caller is not a tenant session, matching `handoff_token_jti`.
 */
export const identityRevocationJti = pgTable(
  'identity_revocation_jti',
  {
    jti: text('jti').primaryKey(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    expiresAtIdx: index('idx_identity_revocation_jti_expires_at').on(t.expiresAt),
  })
)

export type IdentityRevocationJti = typeof identityRevocationJti.$inferSelect
export type NewIdentityRevocationJti = typeof identityRevocationJti.$inferInsert
