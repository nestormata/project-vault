import { index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * Story 30.2 Task 2: server-side pending-handoff state created by `POST /auth/handoff/prepare`
 * (AC3.7) and consumed by `POST /auth/handoff/confirm` (AC4.11). Deliberately a dedicated table
 * rather than reusing `sso_login_states` — that table is provider-generic SSO CSRF state (a
 * single opaque `stateHash` + `providerName`), not a natural fit for this two-step
 * prepare/confirm flow, which needs to carry the already-verified token claims (subject, claimed
 * org, JTI to burn, claims version) forward to the confirm step without re-parsing/re-verifying
 * the raw JWS a second time.
 *
 * `cookieHash` stores an HMAC-SHA256 of the raw confirmation-cookie value — never the raw value
 * itself — mirroring `sso_login_states.stateHash`'s existing hashing precedent.
 *
 * `jti` is carried here (not re-derived) so `POST /auth/handoff/confirm` can perform the
 * insert-first burn into `handoff_token_jti` (AC4.11) using the exact JTI verified at prepare
 * time, without needing the raw JWS again.
 *
 * Deliberately NOT org-scoped (no `orgId` FK, no RLS policy) — same reasoning as
 * `sso_login_states`/`platform_security_events`/`handoff_token_jti`: no tenant is trusted yet at
 * this point (the token's claimed `organizationId` is untrusted input until AC4's org
 * cross-check runs). `expiresAt` gets its own index so the sweeper (AC5.20) can prune orphaned
 * pending-handoff rows independently of the `handoff_token_jti` sweep pass.
 */
export const handoffPendingStates = pgTable(
  'handoff_pending_states',
  {
    id: text('id').primaryKey(),
    cookieHash: text('cookie_hash').notNull().unique(),
    jti: text('jti').notNull(),
    providerName: text('provider_name').notNull(),
    externalSubject: text('external_subject').notNull(),
    organizationId: text('organization_id').notNull(),
    email: text('email'),
    displayName: text('display_name'),
    claimsVersion: integer('claims_version').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    expiresAtIdx: index('idx_handoff_pending_states_expires_at').on(t.expiresAt),
  })
)

export type HandoffPendingState = typeof handoffPendingStates.$inferSelect
export type NewHandoffPendingState = typeof handoffPendingStates.$inferInsert
