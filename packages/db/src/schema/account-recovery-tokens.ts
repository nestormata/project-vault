import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { organizations } from './organizations.js'
import { users } from './users.js'

// Identity-scoped recovery-token table (AC-1). It intentionally has no org_id column on the row
// itself — a recovery token authorizes a credential reset for a user, not an org-scoped resource,
// and a user can belong to many orgs (D2). initiator_org_id records which org's admin sent an
// admin-initiated link, for audit context only; it is not a tenant-isolation boundary for this
// table. Mirrors the no-RLS precedent already documented for mfa_recovery_codes/revoked_tokens.
export const accountRecoveryTokens = pgTable(
  'account_recovery_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    initiatedBy: text('initiated_by').notNull(),
    initiatorUserId: uuid('initiator_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    initiatorOrgId: uuid('initiator_org_id').references(() => organizations.id, {
      onDelete: 'set null',
    }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tokenHashIdx: uniqueIndex('idx_account_recovery_tokens_token_hash').on(t.tokenHash),
    userIdIdx: index('idx_account_recovery_tokens_user_id').on(t.userId),
    expiresAtIdx: index('idx_account_recovery_tokens_expires_at').on(t.expiresAt),
    initiatedByCheck: check(
      'account_recovery_tokens_initiated_by_check',
      sql`${t.initiatedBy} IN ('self','admin')`
    ),
  })
)

export type AccountRecoveryToken = typeof accountRecoveryTokens.$inferSelect
export type NewAccountRecoveryToken = typeof accountRecoveryTokens.$inferInsert
