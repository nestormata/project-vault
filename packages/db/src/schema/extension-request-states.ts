import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * Story 40.1 — extension-scoped, repeatably-readable request state, minted by
 * `POST /api/v1/extensions/oauth-handoff/callback` (AC1) when a loaded extension's
 * `onOAuthCallback()` result includes `persistState`. Deliberately NOT
 * `extension_oauth_pending_states` (Story 39.1) — that table's `consumed_at` is burned
 * atomically on the ONE read `burnPendingState()` performs (single-use/single-read); this
 * story's read side needs a non-destructive, repeatable peek (`context.requestState`, AC2) AND a
 * separate, single-use, destructive consume (`HostServices.extensionRequestState.consume()`,
 * AC3) against the SAME underlying row — extending 39.1's table to add a non-burning read path
 * would change 39.1's own shipped AC3 security property for an unrelated use case (see this
 * story's Finding section).
 *
 * `orgId`/`identityId` (AC12, Red Team elicitation finding) are captured at mint time from the
 * AUTHENTICATED callback session — unlike 39.1's table (whose mint route runs pre-session and
 * therefore has no org/identity to scope by), this story's mint route (the SAME `onOAuthCallback`
 * handler) DOES have a session at that point, since the callback leg completes an authenticated
 * OAuth journey. Both the peek and the consume filter by `orgId`/`identityId` matching the
 * CURRENT request's `ModuleActionContext`, not just `cookieHash` — a hash match against a row
 * minted under a different org/identity resolves to `undefined`, never returns the row's data
 * (AC12), and a rejected cross-org/cross-identity consume attempt must not touch `consumedAt`
 * (fail closed without burning the row for the legitimate caller).
 *
 * `cookieHash` stores an HMAC-SHA256 of the raw cookie value — never the raw value itself —
 * mirroring `extensionOauthPendingStates.cookieHash`'s existing hashing precedent (shared via
 * `apps/api/src/lib/opaque-cookie-token.ts` / `apps/api/src/lib/extension-pending-state.ts`).
 *
 * `stateJson` is the extension's own opaque, JSON-serialized `persistState` object — PV never
 * interprets its contents, only stores/returns it verbatim, scoped by `extensionName` exactly
 * like 39.1's table (never another extension's data).
 *
 * TTL is 30 minutes (`apps/api/src/modules/extensions/oauth-handoff-routes.ts`'s
 * `REQUEST_STATE_TTL_MS`) — longer than 39.1's 8-minute OAuth-round-trip window, since this state
 * must survive a user browsing a selection list, not just a single external-provider round trip.
 * `expiresAt` comparisons always use the database's own `now()` in the query, never app-process
 * wall-clock time, mirroring 39.1's own Pre-Mortem-finding-2 discipline.
 */
export const extensionRequestStates = pgTable(
  'extension_request_states',
  {
    id: text('id').primaryKey(),
    cookieHash: text('cookie_hash').notNull().unique(),
    extensionName: text('extension_name').notNull(),
    orgId: text('org_id').notNull(),
    identityId: text('identity_id').notNull(),
    stateJson: text('state_json').notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    expiresAtIdx: index('idx_extension_request_states_expires_at').on(t.expiresAt),
  })
)

export type ExtensionRequestState = typeof extensionRequestStates.$inferSelect
export type NewExtensionRequestState = typeof extensionRequestStates.$inferInsert
