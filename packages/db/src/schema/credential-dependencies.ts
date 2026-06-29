import { pgTable, uuid, text, timestamp, index, check } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { orgScoped } from './helpers.js'
import { users } from './users.js'
import { credentials } from './credentials.js'

export const credentialDependencies = pgTable(
  'credential_dependencies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...orgScoped({ onDelete: 'cascade' }),
    credentialId: uuid('credential_id')
      .notNull()
      .references(() => credentials.id, { onDelete: 'cascade' }),
    systemName: text('system_name').notNull(),
    systemType: text('system_type').notNull().default('other'),
    notes: text('notes'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    archivedBy: uuid('archived_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    credActiveIdx: index('idx_credential_dependencies_cred_active').on(
      t.credentialId,
      t.archivedAt
    ),
    orgIdx: index('idx_credential_dependencies_org').on(t.orgId),
    systemTypeCheck: check(
      'credential_dependencies_system_type_check',
      sql`${t.systemType} IN ('service','ci_pipeline','database','third_party','other')`
    ),
    systemNameLenCheck: check(
      'credential_dependencies_system_name_len_check',
      sql`char_length(${t.systemName}) BETWEEN 1 AND 256`
    ),
    notesLenCheck: check(
      'credential_dependencies_notes_len_check',
      sql`${t.notes} IS NULL OR char_length(${t.notes}) <= 2048`
    ),
  })
)
