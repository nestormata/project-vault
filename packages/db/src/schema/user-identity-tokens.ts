import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core'
import { users } from './users.js'

// Not org-scoped: platform-level identity table shared across orgs (see Dev Notes).
export const userIdentityTokens = pgTable('user_identity_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  displayName: text('display_name').notNull(),
  pseudonymizedAt: timestamp('pseudonymized_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
