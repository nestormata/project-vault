import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { users } from './users.js'

// Identity-scoped replay table. Stores HMACs, never raw 6-digit TOTP values.
export const totpUsedCodes = pgTable(
  'totp_used_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    replayIdx: uniqueIndex('idx_totp_used_codes_replay').on(t.userId, t.codeHash),
    expiresAtIdx: index('idx_totp_used_codes_expires_at').on(t.expiresAt),
  })
)

export type TotpUsedCode = typeof totpUsedCodes.$inferSelect
export type NewTotpUsedCode = typeof totpUsedCodes.$inferInsert
