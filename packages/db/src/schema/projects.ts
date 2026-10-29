import { sql } from 'drizzle-orm'
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { orgScoped } from './helpers.js'
import { users } from './users.js'

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...orgScoped({ onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    // Optional for legacy callers; new PV-hosted create requests use this as the durable
    // idempotency key. Keeping it on the native project row avoids a second CM/PV ledger.
    creationRequestId: uuid('creation_request_id'),
    description: text('description'),
    tags: jsonb('tags')
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<string[]>(),
    // Projects belong to the org, so deleting a user must not delete their projects.
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    // Story 72-9: reference links for the project (http/https only, validated by the API).
    urls: jsonb('urls')
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<string[]>(),
    // Story 72-9: soft delete with a grace period. A deleted project is also archived
    // (`archived_at` is set at delete time), so every archive-aware reader already hides it; the
    // API treats it as not found, and the purge job removes the row once `purge_after` passes.
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: uuid('deleted_by').references(() => users.id, { onDelete: 'set null' }),
    purgeAfter: timestamp('purge_after', { withTimezone: true }),
  },
  (t) => ({
    orgSlugUnique: uniqueIndex('idx_projects_org_slug').on(t.orgId, t.slug),
    creationRequestUnique: uniqueIndex('idx_projects_creation_request_id')
      .on(t.creationRequestId)
      .where(sql`${t.creationRequestId} IS NOT NULL`),
    orgCreatedIdx: index('idx_projects_org_created').on(t.orgId, t.createdAt.desc()),
    purgeDueIdx: index('idx_projects_purge_due')
      .on(t.purgeAfter)
      .where(sql`${t.deletedAt} IS NOT NULL`),
  })
)
