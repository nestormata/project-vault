import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core'
import { orgScoped } from './helpers.js'
import { projects } from './projects.js'
import { users } from './users.js'

// Story 6.3 (ADR-6.3-05/06/09): one enabled status page per project. The plaintext token is
// never persisted (AC 8) — only its HMAC hash (status-page-tokens.ts) is stored; the unique
// constraint on token_hash doubles as the public lookup index (ADR-6.3-09's admin-connection
// point-lookup). `.unique()` follows this codebase's inline-constraint-naming convention
// (`<table>_<column>_unique`, see organizations.slug) so the concurrent-enable race (AC 8) can
// catch the exact constraint name `status_pages_project_id_unique`.
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
