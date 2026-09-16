import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * Story 39.1 — extension-scoped OAuth pending-state, created by `POST
 * /api/v1/extensions/oauth-handoff/start` (AC1) and consumed by `GET
 * /api/v1/extensions/oauth-handoff/callback` (AC2/AC3). Deliberately NOT `handoffPendingStates`
 * (`handoff-pending-states.ts`) — that table's row shape is auth-handoff-specific (WorkOS claim
 * fields, a `jti` to burn into a SEPARATE `handoff_token_jti` ledger) and this story's Recommended
 * Mechanism Decision explicitly rejects reusing it blindly.
 *
 * `cookieHash` stores an HMAC-SHA256 of the raw start-cookie value — never the raw value itself —
 * mirroring `handoffPendingStates.cookieHash`'s existing hashing precedent.
 *
 * `stateJson` is the extension's own opaque, JSON-serialized `state` object (Recommended Mechanism
 * Decision) — PV never interprets its contents, only stores/returns it verbatim.
 *
 * `extensionName` is carried here (not re-derived) so the callback route can re-check, at callback
 * time, that the SAME extension that started this journey is still loaded and still declares the
 * `oauth-handoff` capability (Assumption Audit finding: "the extension that started the journey is
 * still installed/enabled by the time the callback arrives") before ever invoking
 * `onOAuthCallback()`.
 *
 * Single-use burn-before-use (AC3) is implemented as ONE atomic `UPDATE ... SET consumed_at = now()
 * WHERE cookie_hash = $1 AND consumed_at IS NULL AND expires_at > now() RETURNING *` — deliberately
 * NOT `handoffPendingStates`/`handoffTokenJti`'s two-table insert-first-burn pattern, since a
 * single atomic conditional UPDATE already gives the same replay-safety guarantee (at most one
 * concurrent caller can ever see a non-null `RETURNING` row for a given `cookieHash`) with less
 * schema surface. `expiresAt` comparisons always use the database's own `now()` in the query, never
 * app-process wall-clock time (Pre-Mortem finding 2), so multi-instance clock skew cannot cause an
 * early false rejection.
 *
 * TTL is 8 minutes (480_000ms, `packages/db`'s own copy is a plain column — the actual TTL
 * constant lives in `apps/api/src/modules/extensions/oauth-handoff-routes.ts`), deliberately NOT
 * `handoff-routes.ts`'s 120s `PENDING_TTL_MS` — this journey includes a real network round trip to
 * a third-party OAuth provider's consent screen, and 120s is too tight to copy verbatim
 * (Pre-Mortem finding 1). 5-10 minutes is a typical OAuth `state` TTL convention; 8 minutes is the
 * midpoint, chosen with no further signal favoring either end of that range.
 *
 * Deliberately NOT org-scoped (no `orgId` FK, no RLS policy) — the external OAuth provider's own
 * callback request carries no PV session, so no tenant is trusted yet at insert OR lookup time,
 * mirroring `handoffPendingStates`/`sso_login_states`'s identical no-FK/no-RLS reasoning.
 * `expiresAt` gets its own index so a future pruning worker (mirroring
 * `apps/api/src/workers/prune-handoff-token-jti.ts`) can sweep orphaned rows independently.
 */
export const extensionOauthPendingStates = pgTable(
  'extension_oauth_pending_states',
  {
    id: text('id').primaryKey(),
    cookieHash: text('cookie_hash').notNull().unique(),
    extensionName: text('extension_name').notNull(),
    stateJson: text('state_json').notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    expiresAtIdx: index('idx_extension_oauth_pending_states_expires_at').on(t.expiresAt),
  })
)

export type ExtensionOauthPendingState = typeof extensionOauthPendingStates.$inferSelect
export type NewExtensionOauthPendingState = typeof extensionOauthPendingStates.$inferInsert
