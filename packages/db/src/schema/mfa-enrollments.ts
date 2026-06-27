import { sql } from 'drizzle-orm'
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { users } from './users.js'

export type EncryptedJsonValue = {
  version: number
  iv: string
  ciphertext: string
  tag: string
}

// Identity-scoped MFA table. It intentionally has no org_id and no RLS policy.
export const mfaEnrollments = pgTable(
  'mfa_enrollments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    secretEncrypted: jsonb('secret_encrypted').notNull().$type<EncryptedJsonValue>(),
    status: text('status').notNull().default('pending'),
    label: text('label').notNull().default('Authenticator'),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    statusCheck: check('mfa_enrollments_status_check', sql`${t.status} IN ('pending','confirmed')`),
    pendingUserIdx: uniqueIndex('idx_mfa_enrollments_user_pending')
      .on(t.userId)
      .where(sql`${t.status} = 'pending'`),
    confirmedUserIdx: uniqueIndex('idx_mfa_enrollments_user_confirmed')
      .on(t.userId)
      .where(sql`${t.status} = 'confirmed'`),
    userIdIdx: index('idx_mfa_enrollments_user_id').on(t.userId),
  })
)

export type MfaEnrollment = typeof mfaEnrollments.$inferSelect
export type NewMfaEnrollment = typeof mfaEnrollments.$inferInsert
