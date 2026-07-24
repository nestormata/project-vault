import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  index,
  check,
  boolean,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { orgScoped } from './helpers.js'
import { users } from './users.js'
import { projects } from './projects.js'
import { credentialVersions } from './credential-versions.js'

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
    alertLeadDays: jsonb('alert_lead_days')
      .notNull()
      .default(sql`'[30, 7, 1]'::jsonb`)
      .$type<number[]>(),
    notifiedLeadDays: jsonb('notified_lead_days')
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<number[]>(),
    // cron string validated at the API layer; full lifecycle handling is Story 2.4.
    rotationSchedule: text('rotation_schedule'),
    // Per-credential override of the version retention count (default applied in app layer).
    retentionCount: integer('retention_count').notNull().default(3),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    // Story 7.2 D7 — opt-out flag for the offline agent's local cache (default cacheable).
    cacheable: boolean('cacheable').notNull().default(true),
    // Story 13.1 — explicit FK to the "current" credential_versions row (nullable, no default;
    // backfilled for pre-existing rows by migration 0049). NOT NULL enforcement is deliberately
    // deferred to a later migration (see 0049's header comment) — a zero-version credential has
    // no valid value to assign. Inert until Story 13.2 starts writing to it.
    currentVersionId: uuid('current_version_id').references(
      (): AnyPgColumn => credentialVersions.id
    ),
  },
  (t) => ({
    projectCreatedIdx: index('idx_credentials_project_created').on(t.projectId, t.createdAt.desc()),
    projectExpiresIdx: index('idx_credentials_project_expires').on(t.projectId, t.expiresAt),
    orgIdx: index('idx_credentials_org').on(t.orgId),
    retentionCheck: check('credentials_retention_count_check', sql`${t.retentionCount} >= 1`),
  })
)
