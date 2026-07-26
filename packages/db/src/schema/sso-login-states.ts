import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * Story 14.3 AC-3/AC-4: server-side CSRF-style state for the SSO start/callback round trip.
 * Deliberately NOT org-scoped (no `orgId` column, no RLS policy) — the caller isn't authenticated
 * and no org is known yet at mint time; see Task 2's Dev Notes. `stateHash` stores an HMAC-SHA256
 * of the raw cookie value only — never the raw value itself — mirroring
 * `refresh_tokens.tokenHash`/`recovery-tokens.ts`'s existing hashing precedent.
 */
export const ssoLoginStates = pgTable('sso_login_states', {
  id: uuid('id').primaryKey().defaultRandom(),
  stateHash: text('state_hash').notNull().unique(),
  providerName: text('provider_name').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export type SsoLoginState = typeof ssoLoginStates.$inferSelect
export type NewSsoLoginState = typeof ssoLoginStates.$inferInsert
