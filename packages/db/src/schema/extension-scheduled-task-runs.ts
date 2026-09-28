import { pgTable, uuid, text, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core'
import { orgScoped } from './helpers.js'

/**
 * Story 56.1 Task 3 (ODQ2) — PV-tracked due-state for the `scheduled-task` extension hook. Each
 * row is the per-`(extensionId, taskName, organizationId)` tuple's invocation bookkeeping:
 * - `lastRunAt` is the last SUCCESSFUL invocation, written only on success — a failed invocation
 *   leaves it stale so the tuple stays "due" and is retried on the next qualifying tick (56.1 AC2's
 *   accepted no-backoff behavior).
 * - `lastAttemptAt` (Story 56.2 AC1) is the completion time of the last invocation ATTEMPT,
 *   success or failure/timeout; `lastOutcome` is `'success'` or `'failure'` for that attempt. The
 *   missed-tick watchdog (`extension-scheduled-tasks-watchdog.ts`) reads
 *   `COALESCE(lastAttemptAt, lastRunAt)` so rows written before this column existed still count.
 *
 * **Why `extensionId` is a plain `text` column, not an FK** — confirmed directly against this
 * repo's real source during this story's implementation (mirroring `extension-lifecycle-notify.ts`
 * / `getExtensionStatus()`'s single-extension-per-process precedent): PV has no per-org
 * "extension installed" table at all. PV runs at most one loaded extension per process
 * (`apps/api/src/extensions/loader.ts`'s module-level `state`), and there is no separate
 * install/activation record to foreign-key against. `orgId`'s own `ON DELETE CASCADE` (via
 * `orgScoped`) is therefore the real orphan-prevention mechanism this table relies on — deleting
 * an org deletes its due-state rows. Uninstalling/replacing the loaded extension process-wide does
 * NOT cascade-delete this table's rows for the old `extensionId` (there is nothing to cascade
 * from) — those rows become inert (no `(org, task)` due-tuple query will ever match a
 * no-longer-loaded `extensionId` again) but are not actively cleaned up; accepted, unbounded-growth
 * debt of the same class already accepted elsewhere in this codebase (see this story's Dev Notes
 * Elicitation Findings), revisit only if it becomes operationally visible.
 *
 * All due-check comparisons MUST use the database server's clock (SQL `now()`), never
 * application-server wall-clock time (Task 3) — see `extension-scheduled-tasks.ts`'s due-tuple
 * query, which reads this table's `lastRunAt` but never writes/compares it in application code.
 */
export const extensionScheduledTaskRuns = pgTable(
  'extension_scheduled_task_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...orgScoped({ onDelete: 'cascade' }),
    extensionId: text('extension_id').notNull(),
    taskName: text('task_name').notNull(),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    lastOutcome: text('last_outcome'),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    extensionTaskOrgUnique: uniqueIndex('uq_extension_scheduled_task_runs_extension_task_org').on(
      t.extensionId,
      t.taskName,
      t.orgId
    ),
    orgIdx: index('idx_extension_scheduled_task_runs_org_id').on(t.orgId),
  })
)
