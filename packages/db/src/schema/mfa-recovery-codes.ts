import { sql } from 'drizzle-orm'
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { users } from './users.js'

// Identity-scoped recovery codes. Only bcrypt hashes are stored.
export const mfaRecoveryCodes = pgTable(
  'mfa_recovery_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userUnusedIdx: index('idx_mfa_recovery_codes_user_unused')
      .on(t.userId)
      .where(sql`${t.usedAt} IS NULL`),
    userIdIdx: index('idx_mfa_recovery_codes_user_id').on(t.userId),
  })
)

export type MfaRecoveryCode = typeof mfaRecoveryCodes.$inferSelect
export type NewMfaRecoveryCode = typeof mfaRecoveryCodes.$inferInsert
