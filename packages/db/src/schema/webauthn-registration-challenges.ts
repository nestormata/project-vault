import { sql } from 'drizzle-orm'
import { check, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { users } from './users.js'

// One pending registration challenge per user. Single-use, short TTL. No org_id, no RLS.
export const webauthnRegistrationChallenges = pgTable(
  'webauthn_registration_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    challenge: text('challenge').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('idx_webauthn_registration_challenges_user_id').on(t.userId),
    check(
      'webauthn_registration_challenges_expires_after_created_check',
      sql`${t.expiresAt} > ${t.createdAt}`
    ),
  ]
)

export type WebauthnRegistrationChallenge = typeof webauthnRegistrationChallenges.$inferSelect
export type NewWebauthnRegistrationChallenge = typeof webauthnRegistrationChallenges.$inferInsert
