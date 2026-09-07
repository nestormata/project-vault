import { pgTable, uuid, text, timestamp, integer, jsonb, check, index } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { orgScoped } from './helpers.js'
import { projects } from './projects.js'

/**
 * Story 35.1 Design Decision 4 — durable outbox table backing `ExtensionHooks.
 * projectArchiveNotifier`. Modeled directly on `notification-queue.ts`'s shape (`orgScoped`,
 * `status` CHECK constraint, `attemptCount`, `lastAttemptAt`, a partial pending index) but is a
 * SEPARATE table, not a reuse of `notification_queue` — see Design Decision 4's Architecture
 * Decision Record for why: `notification_queue` is channel-shaped ("a message to a human"), not
 * "a structured event payload for an extension," and its retry/backoff tuning is calibrated for
 * SMTP/webhook delivery characteristics, not a single in-process extension callout.
 *
 * **Archive-vs-delete honesty (AC6):** despite the table name mentioning "lifecycle events" in
 * general (deliberately left open via `eventType`, a plain `text` column, not a narrow CHECK —
 * Design Decision 7 — so a future, wholly separate hard-delete event type can reuse this same
 * outbox/worker additively), every row this story's own code ever inserts has
 * `eventType = 'project_archived'`, corresponding to PV's own ARCHIVE (non-destructive,
 * reversible) operation — never a deletion. A future reader who finds only this table's name,
 * without reading Story 35.1's own Dev Notes, should not assume "lifecycle event" implies
 * "deletion" — it does not.
 *
 * `projectId` FK is `onDelete: 'cascade'` — note this only ever fires if a `projects` row is
 * later removed by some OTHER mechanism (e.g. an org-deletion cascade); archiving a project does
 * NOT delete its `projects` row (see `apps/api/src/modules/projects/routes.ts`'s archive/
 * unarchive pair), so this FK's cascade path is not the normal lifecycle of this table's rows.
 */
export const extensionLifecycleEvents = pgTable(
  'extension_lifecycle_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...orgScoped({ onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    // Open string, not an enum of exactly 'project_archived' — Design Decision 7: a future
    // hard-delete story can add eventType = 'project_deleted' additively, reusing this same
    // table/worker, without a breaking schema change.
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),
    status: text('status').notNull().default('pending'),
    attemptCount: integer('attempt_count').notNull().default(0),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  },
  (t) => ({
    statusCheck: check(
      'extension_lifecycle_events_status_check',
      sql`${t.status} IN ('pending','delivered','failed')`
    ),
    pendingIdx: index('idx_extension_lifecycle_events_pending')
      .on(t.orgId, t.status)
      .where(sql`${t.status} = 'pending'`),
    createdAtIdx: index('idx_extension_lifecycle_events_created_at').on(t.createdAt),
  })
)
