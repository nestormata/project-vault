import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { organizations } from './organizations.js'
import { sessions } from './sessions.js'

// Identity-scoped auth table. org_id is context metadata for RLS-aware session lookup;
// refresh-token rows are still not isolated by org RLS because lookup starts from a bearer token.
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    newSessionId: uuid('new_session_id').references(() => sessions.id, { onDelete: 'set null' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tokenHashIdx: uniqueIndex('idx_refresh_tokens_token_hash').on(t.tokenHash),
    orgIdIdx: index('idx_refresh_tokens_org_id').on(t.orgId),
    sessionIdIdx: index('idx_refresh_tokens_session_id').on(t.sessionId),
    expiresAtIdx: index('idx_refresh_tokens_expires_at').on(t.expiresAt),
  })
)

export type RefreshToken = typeof refreshTokens.$inferSelect
export type NewRefreshToken = typeof refreshTokens.$inferInsert
