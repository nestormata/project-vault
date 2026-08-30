import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * Story 30.2 AC1: durable insert-first replay-burn ledger for CentralizeMe-issued handoff
 * tokens. The primary key on `jti` IS the replay-burn mechanism (AC1.3/AC4.13) — a bare `INSERT`
 * that either succeeds once or fails on a unique-violation for every concurrent racer, never a
 * `SELECT`-then-`INSERT` (see `sso_login_states`'s `consumeState()` row-locking pattern, which is
 * deliberately NOT reused here — a handoff JTI has no pre-existing row to lock).
 *
 * Deliberately NOT `revoked_tokens`: that table's `user_id NOT NULL` FK is unavailable before
 * user resolution (a handoff JTI is burned before any user/org is known). Deliberately no
 * `user_id`/`org_id` FK and no RLS policy here either — same reasoning as `sso_login_states`/
 * `platform_security_events`: no tenant is known at ingestion time. The `expires_at` index
 * mirrors `revoked_tokens`' `idx_revoked_tokens_expires_at` naming/sweeper-precedent exactly.
 */
export const handoffTokenJti = pgTable(
  'handoff_token_jti',
  {
    jti: text('jti').primaryKey(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    expiresAtIdx: index('idx_handoff_token_jti_expires_at').on(t.expiresAt),
  })
)

export type HandoffTokenJti = typeof handoffTokenJti.$inferSelect
export type NewHandoffTokenJti = typeof handoffTokenJti.$inferInsert
