import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { orgScoped } from './helpers.js'
import { users } from './users.js'
import { credentials } from './credentials.js'

// Story 17.1 AC-6: table shared with Story 17.2's external-recipient path (recipient_type =
// 'external' / recipient_email) — this story only ever writes recipient_type = 'user' rows, the
// external half of the table exists now so 17.2 doesn't need a second migration touching this
// same table, but is unused and unreachable from this story's routes.
export const credentialShares = pgTable(
  'credential_shares',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...orgScoped(),
    credentialId: uuid('credential_id')
      .notNull()
      .references(() => credentials.id, { onDelete: 'cascade' }),
    // Story 13.4/13.2 field_key precedent: mirrors credential_dependencies.field_key's
    // single-nullable-text-column shape (not rotations.target_fields' array shape) — a share
    // always targets at most one field or the whole credential. NULL = whole-credential value.
    fieldKey: text('field_key'),
    // Story 20.5 (Scoped/Bounded Sharing Contract, Epic 20 Story 20.4): generalizes `fieldKey`
    // without narrowing its existing behavior — NULL means "defer to `fieldKey`, or if that is
    // also NULL, whole-resource with sensitivity-default-exclusion applied at serialization time
    // (see `effectiveAttributeKeysForShare` in service.ts)". A non-null, non-empty array is an
    // explicit allow-list of attribute/field keys (naming a key is explicit consent, sensitive or
    // not). `fieldKey` is left fully intact for existing (Epic 17) call paths — this column is
    // strictly additive, never a replacement.
    attributeKeys: text('attribute_keys').array(),
    // Story 20.5: `BoundedShareScope.action` — `'read'` only in this contract version (see
    // architecture.md's Scoped/Bounded Sharing Contract). Persisted (not merely validated at the
    // API layer) so a future contract revision that adds a second action value has a real column
    // to migrate rather than an implicit default with no persisted record of the decision.
    action: text('action').notNull().default('read').$type<'read'>(),
    sharedBy: uuid('shared_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    recipientType: text('recipient_type').notNull(),
    recipientUserId: uuid('recipient_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    recipientEmail: text('recipient_email'),
    // Only the hash is ever persisted (mirrors session/refresh-token bearer-secret handling) —
    // the raw token is returned to the sharer exactly once, at creation time, and never stored.
    tokenHash: text('token_hash').notNull(),
    // Dev Notes reconciliation: AC-6's literal column list (sprint-change-proposal-2026-07-24.md
    // §4.3) omits a single-use/multi-view flag, but AC-4 requires distinguishing the two — a
    // `singleUse: false` share must remain viewable (re-incrementing view_count) until expiry
    // instead of transitioning to the terminal 'viewed' status on its first reveal. Added as a
    // necessary, additive column rather than silently guessing the behavior from `status` alone
    // (see story Dev Agent Record for the full reconciliation note).
    singleUse: boolean('single_use').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    firstViewedAt: timestamp('first_viewed_at', { withTimezone: true }),
    viewCount: integer('view_count').notNull().default(0),
    status: text('status').notNull().default('active'),
    // Story 17.2 AC-22: per-token reveal-attempt cap for the external/unauthenticated path — a
    // claim-attempt that resolves to this row but loses (not a hash-mismatch) increments this;
    // exceeding EXTERNAL_SHARE_MAX_REVEAL_ATTEMPTS auto-revokes the share. Additive column, same
    // reconciliation precedent as 17.1's own `single_use` column (see that story's Dev Agent
    // Record) — the story's "no new migration" Dev Notes text predates AC-22, which was added by
    // a later advanced-elicitation pass and genuinely needs persisted, cross-request state.
    // Unused (always 0) for `recipient_type = 'user'` rows.
    revealAttemptCount: integer('reveal_attempt_count').notNull().default(0),
  },
  (t) => ({
    // AC-19: defense-in-depth against an implementation ever colliding two live tokens.
    tokenHashUnique: uniqueIndex('idx_credential_shares_token_hash').on(t.tokenHash),
    // "My shares for this credential" (Shares tab) / archival-guard active-share lookups.
    credentialStatusIdx: index('idx_credential_shares_credential_status').on(
      t.credentialId,
      t.status
    ),
    // Recipient's "shares addressed to me" / reveal-step lookups.
    recipientStatusIdx: index('idx_credential_shares_recipient_status').on(
      t.recipientUserId,
      t.status
    ),
    orgIdx: index('idx_credential_shares_org').on(t.orgId),
    recipientTypeCheck: check(
      'credential_shares_recipient_type_check',
      sql`${t.recipientType} IN ('user','external')`
    ),
    statusCheck: check(
      'credential_shares_status_check',
      sql`${t.status} IN ('active','viewed','revoked','expired','superseded')`
    ),
    // Story 20.5 AC-1: `action` accepts only `'read'` in this contract version — enforced at the
    // database level too, not just the Zod schema, matching this table's existing double-enforced
    // `recipient_type`/`status` convention.
    actionCheck: check('credential_shares_action_check', sql`${t.action} IN ('read')`),
    // Bugfix (post-implementation review): backs up `schema.ts`'s Zod-level
    // `rejectBothFieldKeyAndAttributeKeys` `.refine` with a real DB invariant — `field_key` and
    // `attribute_keys` are two spellings of the same scope concept (see `attributeKeys` column
    // comment above) and must never both be set on the same row, regardless of write path.
    fieldKeyAttributeKeysCheck: check(
      'credential_shares_field_key_attribute_keys_check',
      sql`NOT (${t.fieldKey} IS NOT NULL AND ${t.attributeKeys} IS NOT NULL)`
    ),
    // Story 20.5 (review patch): backs up `schema.ts`'s Zod-level `AttributeKeysSchema.min(1)`
    // with a real DB invariant — an explicit `attribute_keys = '{}'` is ambiguous ("named nothing"
    // vs. "whole-resource") and this table's other invariants are already double-enforced at the
    // DB layer, not just Zod (see `actionCheck`/`fieldKeyAttributeKeysCheck` above).
    attributeKeysNotEmptyCheck: check(
      'credential_shares_attribute_keys_not_empty_check',
      sql`${t.attributeKeys} IS NULL OR cardinality(${t.attributeKeys}) > 0`
    ),
  })
)
