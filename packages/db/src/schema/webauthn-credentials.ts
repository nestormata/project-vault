import { sql } from 'drizzle-orm'
import {
  bigint,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { users } from './users.js'

// Identity-scoped WebAuthn credential table. Public key and sign count only. No org_id, no RLS.
export const webauthnCredentials = pgTable(
  'webauthn_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    credentialId: text('credential_id').notNull(),
    publicKey: text('public_key').notNull(),
    signCount: bigint('sign_count', { mode: 'number' }).notNull().default(0),
    transports: text('transports'),
    aaguid: text('aaguid'),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('idx_webauthn_credentials_credential_id').on(t.credentialId),
    index('idx_webauthn_credentials_user_id').on(t.userId),
    check('webauthn_credentials_sign_count_check', sql`${t.signCount} >= 0`),
    check('webauthn_credentials_name_length_check', sql`char_length(${t.name}) BETWEEN 1 AND 64`),
  ]
)

export type WebauthnCredential = typeof webauthnCredentials.$inferSelect
export type NewWebauthnCredential = typeof webauthnCredentials.$inferInsert
