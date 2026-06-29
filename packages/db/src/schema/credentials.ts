import { pgTable, uuid, text, timestamp, integer, jsonb, index, check } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { orgScoped } from './helpers.js'
import { users } from './users.js'
import { projects } from './projects.js'

export const credentials = pgTable(
  'credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...orgScoped({ onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    // tags stored as a JSONB string array; search/management lands in Story 2.3.
    tags: jsonb('tags')
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<string[]>(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    // cron string validated at the API layer; full lifecycle handling is Story 2.4.
    rotationSchedule: text('rotation_schedule'),
    // Per-credential override of the version retention count (default applied in app layer).
    retentionCount: integer('retention_count').notNull().default(3),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectCreatedIdx: index('idx_credentials_project_created').on(t.projectId, t.createdAt.desc()),
    projectExpiresIdx: index('idx_credentials_project_expires').on(t.projectId, t.expiresAt),
    orgIdx: index('idx_credentials_org').on(t.orgId),
    retentionCheck: check('credentials_retention_count_check', sql`${t.retentionCount} >= 1`),
  })
)
