import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { orgScoped } from './helpers.js'
import { users } from './users.js'
import { projects } from './projects.js'
import { credentials } from './credentials.js'
import { credentialVersions } from './credential-versions.js'

// One row per initiated rotation, permanently retained (FR23) — no route in this story or
// Story 5.2/5.3 ever DELETEs a rotation row. NOTE: "permanently retained" is NOT the same as
// "immutable" — Story 5.2 UPDATEs `status`/`version`/`completedAt` on these same rows as the
// rotation progresses (confirm/fail/retry/complete), which is exactly why AC-3 adds an
// `updated_at` trigger to this table. The durable invariant is row-level permanence (never
// deleted, never re-created), not field-level immutability — don't conflate the two.
// `status` CHECK lists the FULL Epic 5 state machine now (5.1 only ever writes 'in_progress')
// so Stories 5.2/5.3 and the Story 4.3/4.4 forward-reference stubs never need a second
// migration to widen this constraint.
export const rotations = pgTable(
  'rotations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...orgScoped({ onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    credentialId: uuid('credential_id')
      .notNull()
      .references(() => credentials.id, { onDelete: 'cascade' }),
    // Direct FK linkage to the two credential_versions rows this rotation touches (NOT
    // inferable-only via credentialId + rotation_locked_at). credential_versions rows are
    // never hard-deleted (Story 2.2's retention job UPDATEs them — nulls the value, sets
    // purgedAt — it never DELETEs), so 'restrict' is safe and correct here: it documents the
    // invariant (a version referenced by a rotation is never removed) without ever actually
    // firing, and it lets 5.2/5.3 join directly instead of re-deriving "the locked version"
    // by inference (credentialId + rotation_locked_at IS NOT NULL), which breaks the moment
    // more than one locked version can exist per credential.
    newVersionId: uuid('new_version_id')
      .notNull()
      .references(() => credentialVersions.id, { onDelete: 'restrict' }),
    previousVersionId: uuid('previous_version_id')
      .notNull()
      .references(() => credentialVersions.id, { onDelete: 'restrict' }),
    status: text('status').notNull().default('in_progress'),
    // Optimistic-lock column (RS-E5a) — incremented on every state transition. Story 5.1
    // only ever writes 1 (at creation); Story 5.2 increments it on confirm/fail/retry/complete.
    version: integer('version').notNull().default(1),
    initiatedBy: uuid('initiated_by').references(() => users.id, { onDelete: 'set null' }),
    initiatedAt: timestamp('initiated_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Backstop for the advisory-lock race (see AC-4/AC-5): the DB, not the lock, is the
    // durable source of truth for "at most one in_progress rotation per credential".
    oneInProgressPerCredential: uniqueIndex('idx_rotations_one_in_progress_per_credential')
      .on(t.credentialId)
      .where(sql`${t.status} = 'in_progress'`),
    projectInitiatedIdx: index('idx_rotations_project_initiated').on(
      t.projectId,
      t.initiatedAt.desc()
    ),
    credentialStatusIdx: index('idx_rotations_credential_status').on(t.credentialId, t.status),
    orgIdx: index('idx_rotations_org').on(t.orgId),
    statusCheck: check(
      'rotations_status_check',
      sql`${t.status} IN ('in_progress','completed','abandoned','stale_recovery','break_glass_complete')`
    ),
  })
)
