import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { users } from './users.js'

/**
 * Story 1.19 D6: platform-level (instance-wide, not org-scoped), RLS-exempt table for the
 * optional `GET /status` bearer token — mirrors `api_keys`' hashed-token/rotation shape
 * (`tokenHash`, `hmacKeyVersion`, `revokedAt`, `createdAt`, `rotatedFromTokenId`) but is not
 * org-scoped, same platform-singleton rationale as `system_settings`/`vault_state` (no `org_id`
 * column, so `check-rls-coverage.ts`'s org_id-column heuristic never flags it — see that file's
 * `EXCLUDED_TABLES` comment block for the established precedent this follows).
 *
 * Unlike `system_settings` this is NOT a strict single-row table: rotation inserts a new row and
 * revokes the old one (same lifecycle as `api_keys`), so history of prior tokens (all hashed,
 * never plaintext) is retained for audit purposes. "The active token" is defined as the newest
 * row with `revokedAt IS NULL` — primarily enforced in `apps/api/src/modules/platform-admin/`
 * service code via a `pg_advisory_xact_lock` (a revoke-then-immediate-generate race is handled
 * at the application layer via the platform audit transaction). Adversarial review fix: that
 * app-level lock is now backstopped by `uniqueActiveTokenIdx` below — a partial unique index on
 * the constant expression `(true)` filtered to `revoked_at IS NULL`, which Postgres enforces as
 * "at most one row may satisfy this predicate" (every row satisfying it maps to the same `true`
 * value, so uniqueness collapses to a single-row cardinality limit) — so the invariant holds even
 * if application-level locking is ever bypassed or has a bug.
 */
export const operationalStatusTokens = pgTable(
  'operational_status_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tokenHash: text('token_hash').notNull(),
    // Reserved for future HMAC-secret rotation support (mirrors api_keys' column of the same
    // name) — not yet read or written meaningfully beyond this constant default; do not assume
    // it is live.
    hmacKeyVersion: integer('hmac_key_version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // Adversarial review fix: FK to users, matching platform_audit_events.operatorId's pattern —
    // always populated from a real authenticated operator (never a synthetic/system value), so
    // the constraint cannot be violated by existing write paths.
    createdByUserId: uuid('created_by_user_id').references(() => users.id),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    rotatedFromTokenId: uuid('rotated_from_token_id'),
  },
  (t) => ({
    tokenHashIdx: index('idx_operational_status_tokens_token_hash').on(t.tokenHash),
    // Partial index: fast "find the active token" lookup (WHERE revoked_at IS NULL), not a
    // uniqueness constraint — see class doc comment on why enforcement is application-level.
    activeIdx: index('idx_operational_status_tokens_active')
      .on(t.createdAt)
      .where(sql`${t.revokedAt} IS NULL`),
    // DB-level backstop for the "at most one active token" invariant (see class doc comment) —
    // rejects a second concurrent insert of a non-revoked row even if the app-level advisory
    // lock is ever bypassed or buggy.
    uniqueActiveTokenIdx: uniqueIndex('uq_operational_status_tokens_single_active')
      .on(sql`(true)`)
      .where(sql`${t.revokedAt} IS NULL`),
    rotatedFromTokenIdFk: foreignKey({
      columns: [t.rotatedFromTokenId],
      foreignColumns: [t.id],
      name: 'operational_status_tokens_rotated_from_token_id_fk',
    }),
    tokenHashLenCheck: check(
      'operational_status_tokens_token_hash_len_check',
      sql`char_length(${t.tokenHash}) = 64`
    ),
  })
)

export type OperationalStatusToken = typeof operationalStatusTokens.$inferSelect
export type NewOperationalStatusToken = typeof operationalStatusTokens.$inferInsert
