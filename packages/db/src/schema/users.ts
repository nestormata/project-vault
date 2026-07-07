import { boolean, pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core'

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  mfaEnrolledAt: timestamp('mfa_enrolled_at', { withTimezone: true }),
  // Story 9.1 D1: instance-wide (not org-scoped) authorization flag. The very first user ever
  // registered on a freshly-initialized instance is bootstrapped as the platform operator (see
  // registerUser() in apps/api/src/modules/auth/service.ts); every subsequent registration
  // defaults to false. A unique partial index (idx_users_one_platform_operator, migration 0038)
  // guarantees at most one row can ever have this set to true.
  isPlatformOperator: boolean('is_platform_operator').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
