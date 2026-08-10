import { pgTable, uuid, text, integer, jsonb, timestamp, index } from 'drizzle-orm/pg-core'
import { orgScoped } from './helpers.js'
import { projects } from './projects.js'
import { users } from './users.js'
import type { EncryptedValue } from '@project-vault/crypto'

// Story 6.3 (ADR-6.3-05/06/09): one enabled status page per project. `tokenHash` (HMAC,
// status-page-tokens.ts) is the sole public-lookup mechanism; the unique constraint on it doubles
// as the public lookup index (ADR-6.3-09's admin-connection point-lookup). `.unique()` follows
// this codebase's inline-constraint-naming convention (`<table>_<column>_unique`, see
// organizations.slug) so the concurrent-enable race (AC 8) can catch the exact constraint name
// `status_pages_project_id_unique`. Story 21.7 adds `encryptedToken` below, a vault-decryptable
// copy of the token kept only for owner-facing redisplay — see that field's comment.
export const statusPages = pgTable(
  'status_pages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...orgScoped({ onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .unique()
      .references(() => projects.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    // Story 21.7: the token additionally stored as a vault-decryptable value so the
    // owner-facing settings page can redisplay the link without regenerating it (tokenHash
    // remains the sole public-lookup mechanism — see public-status-page-routes.ts). Nullable so
    // rows created before this migration (and rows written while the vault happened to be
    // sealed, which can't happen today since enable/regenerate require an unsealed vault) keep
    // working: `null` just means "no persistent redisplay available, regenerate to get one".
    // Same encryptedValue/keyVersion shape as credential-versions.ts.
    encryptedToken: jsonb('encrypted_token').$type<EncryptedValue | null>(),
    keyVersion: integer('key_version'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index('idx_status_pages_org').on(t.orgId),
  })
)

export type StatusPage = typeof statusPages.$inferSelect
export type NewStatusPage = typeof statusPages.$inferInsert
