import { sql } from 'drizzle-orm'
import { check, index, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core'
import { orgScoped } from './helpers.js'

/**
 * Story 71.7 — durable, shared, org-isolated burn ledger for service-delegated actor assertions
 * (71-2 design note section 4.3, check 12). The `(org_id, jti)` primary key IS the replay
 * decision: the store inserts first and reads a `23505` on this key as "replayed", never a
 * `SELECT`-then-`INSERT`.
 *
 * Unlike `handoff_token_jti` (RLS-exempt: no tenant is known at ingestion) the delegation burn
 * runs after org resolution, so this table is FORCE-RLS org-scoped with the standard policy.
 * `vault_app` is append-only (SELECT, INSERT): application code can never un-burn a row. Expired
 * rows are reclaimed only by the `delegation/prune-assertion-jti` worker through the admin pool's
 * column-level grant (migration 0103).
 *
 * `kid` is stored for forensics but is deliberately NOT part of the key: a jti is single-use per
 * org whatever key signed it. No payload, actor or body hash is stored.
 */
export const delegationAssertionJti = pgTable(
  'delegation_assertion_jti',
  {
    ...orgScoped({ onDelete: 'cascade' }),
    jti: text('jti').notNull(),
    kid: text('kid').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.jti] }),
    expiresAtIdx: index('idx_delegation_assertion_jti_expires_at').on(t.expiresAt),
    // Defence in depth behind the store's own input validation (D10/D11).
    jtiLen: check(
      'delegation_assertion_jti_jti_len',
      sql`octet_length(${t.jti}) BETWEEN 1 AND 128`
    ),
    kidLen: check(
      'delegation_assertion_jti_kid_len',
      sql`octet_length(${t.kid}) BETWEEN 1 AND 128`
    ),
  })
)

export type DelegationAssertionJti = typeof delegationAssertionJti.$inferSelect
export type NewDelegationAssertionJti = typeof delegationAssertionJti.$inferInsert
