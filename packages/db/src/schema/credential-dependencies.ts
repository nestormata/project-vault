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
    // Story 2.10 AC-1 — optional deep-link to the dependent system's location (e.g. a CI
    // pipeline's secrets settings page). Display-only; never fetched server-side (ADR-2.10-05).
    linkUrl: text('link_url'),
    // Story 13.4: nullable, purely additive. NULL = whole-credential dependency (default for
    // every dependency created before and during this story — this story does not add a UI/API
    // surface for setting this on creation, a deliberate judgment call, see story Dev Notes).
    // When set, a field-scoped rotation's checklist only includes this dependency if the
    // rotation's targetFields includes this key (or the rotation is whole-secret).
    fieldKey: text('field_key'),
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
    // Story 2.10 AC-1: defense-in-depth length bound only — URL shape validation happens at the
    // Zod schema layer (AC-3), not here (Postgres has no built-in URL type).
    linkUrlLenCheck: check(
      'credential_dependencies_link_url_len_check',
      sql`${t.linkUrl} IS NULL OR char_length(${t.linkUrl}) <= 2048`
    ),
  })
)
