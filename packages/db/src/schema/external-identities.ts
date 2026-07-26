import { pgTable, uuid, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'
import { orgScoped } from './helpers.js'
import { users } from './users.js'

/**
 * Story 14.3 AC-5/AC-7/AC-8/AC-9/AC-10: binds a local `users` row to an external identity
 * provider's subject identifier, scoped per-org. Never auto-created from an email match alone
 * (see AC-7) — only via an explicit OrgAdmin link (AC-10) or the AC-8 invitation-consent path.
 */
export const externalIdentities = pgTable(
  'external_identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...orgScoped({ onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    providerName: text('provider_name').notNull(),
    externalSubject: text('external_subject').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // AC-5/AC-7: (org_id, provider_name, external_subject) is the exact lookup key the callback
    // handler resolves a session from; AC-10's dedicated duplicate-link test relies on this same
    // unique index producing a 23505 rather than a silent overwrite.
    orgProviderSubjectIdx: uniqueIndex('idx_external_identities_org_provider_subject').on(
      t.orgId,
      t.providerName,
      t.externalSubject
    ),
  })
)

export type ExternalIdentity = typeof externalIdentities.$inferSelect
export type NewExternalIdentity = typeof externalIdentities.$inferInsert
