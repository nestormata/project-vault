import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * Story 73.1: the browser-bound handoff nonce. `GET /auth/start` on PV web asks the api to mint a
 * nonce, stores `HMAC(nonce)` here with a 120 s expiry, and puts the raw nonce in a host-only
 * cookie. `POST /auth/handoff/claim` consumes the row (sets `consumed_at`) on first presentation,
 * whatever the outcome, before it checks the token's `nonce` claim against it.
 *
 * Only the HMAC is stored (`hashCookieValue`), never the raw nonce. No `org_id`/`user_id` and no
 * RLS: no tenant is known when the row is written, same as `handoff_token_jti`. `consumed_at`
 * stays on the row (instead of a delete) so a second presentation is classified as reused, not
 * unknown. The prune job deletes rows past `expires_at`.
 */
export const handoffNonces = pgTable(
  'handoff_nonces',
  {
    nonceHash: text('nonce_hash').primaryKey(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    expiresAtIdx: index('idx_handoff_nonces_expires_at').on(t.expiresAt),
  })
)

export type HandoffNonce = typeof handoffNonces.$inferSelect
export type NewHandoffNonce = typeof handoffNonces.$inferInsert
