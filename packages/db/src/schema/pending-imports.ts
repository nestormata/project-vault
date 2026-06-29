import { pgTable, uuid, text, timestamp, integer, jsonb, check } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import type { EncryptedValue } from '@project-vault/crypto'
import { orgScoped } from './helpers.js'
import { users } from './users.js'
import { projects } from './projects.js'

export type PendingImportItemRecord = {
  name: string
  encryptedValue: EncryptedValue
  keyVersion: number
  conflictsWith: string | null
  suggestedAction: 'new_version' | 'skip' | 'create_new'
}

export type ParseWarning = {
  line: number
  reason: 'no_equals_sign' | 'empty_value' | 'invalid_key' | 'duplicate_key'
  raw: string
}

export const pendingImports = pgTable(
  'pending_imports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...orgScoped({ onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    fileType: text('file_type').notNull(),
    itemCount: integer('item_count').notNull(),
    items: jsonb('items').notNull().$type<PendingImportItemRecord[]>(),
    warnings: jsonb('warnings')
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<ParseWarning[]>(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    fileTypeCheck: check('pending_imports_file_type_check', sql`${t.fileType} IN ('env', 'json')`),
    itemCountCheck: check(
      'pending_imports_item_count_check',
      sql`${t.itemCount} BETWEEN 0 AND 500`
    ),
  })
)
