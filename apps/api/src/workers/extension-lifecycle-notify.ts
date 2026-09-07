import { sql } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import type { FastifyBaseLogger } from 'fastify'
import { OperationalEvent } from '@project-vault/shared'
import type { ProjectArchivedContext, ProjectArchiveNotifier } from '@project-vault/extension-api'
import { fetchAllOrgIds, runOrgScopedJob } from '../middleware/rls.js'
import { getExtensionStatus } from '../extensions/loader.js'
import { raceWithTimeout } from '../lib/race-with-timeout.js'
import { EXTENSION_CALLOUT_TIMEOUT_MS } from '../lib/extension-callout-timeout.js'
import { operationalLog } from '../lib/logger.js'
import { withJobLogging } from '../lib/job-logging.js'

/**
 * Story 35.1 Task 4 — background worker dispatching `extension_lifecycle_events` pending rows to
 * the loaded extension's `projectArchiveNotifier.onProjectArchived()` hook. Mirrors
 * `notification-deliver.ts`'s poll/claim/dispatch/mark-result loop structure and this repo's own
 * `raceWithTimeout()` extension-callout convention (`PROJECT_CREATE_POLICY_TIMEOUT_MS`, reused
 * here as `EXTENSION_CALLOUT_TIMEOUT_MS` — Design Decision 4: "reused verbatim, not reinvented").
 *
 * Runs entirely outside the HTTP request/response cycle (AC5) — `apps/api/src/modules/projects/
 * routes.ts`'s archive route only ever inserts the pending row in its own transaction; nothing in
 * the request path calls this worker or awaits its result.
 */

export const EXTENSION_LIFECYCLE_NOTIFY_JOB_NAME = 'extension-lifecycle/notify'
export const EXTENSION_LIFECYCLE_PURGE_JOB_NAME = 'extension-lifecycle/purge-resolved'

// Mirrors notification-worker-common.ts's NOTIFICATION_MAX_ATTEMPTS precedent (5) — a Task
// decision, not a value with independent significance.
export const EXTENSION_LIFECYCLE_NOTIFY_MAX_ATTEMPTS = 5

// AC3's fairness/latency callout (Security Audit Personas, hacker/fairness persona): the worker
// dispatches rows for one org serially, so a batch cap bounds how much of one poll cycle a single
// org's backlog can consume before other orgs get a turn on the NEXT poll cycle. An
// implementation Task decision, not a value with independent significance — a pathologically
// slow (but technically compliant, never-timing-out) extension still degrades delivery latency
// for every org's pending rows behind it within a cycle; this is an accepted consequence of the
// existing single-extension-per-process model (Story 34.1's own Dev Notes precedent), not a
// security boundary violation.
const BATCH_SIZE_PER_ORG = 25

// Task 4 Operational Considerations — notification_queue itself has no existing retention/purge
// mechanism for delivered/failed rows to mirror (confirmed by repo-wide grep during this story's
// implementation: no DELETE/purge job of any kind touches notification_queue's resolved rows
// today). Rather than leave extension_lifecycle_events' own resolved-row retention unbounded too
// (the exact "unbounded-growth incident" Dev Notes warns against), this adds a minimal periodic
// purge of this story's own new table — deliberately NOT extended to notification_queue itself,
// which is out of this story's scope.
const RESOLVED_ROW_RETENTION_DAYS = 30

type WorkerLogger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>

type PendingRow = {
  id: string
  project_id: string
  attempt_count: number
}

type DispatchOutcome = { kind: 'claimed'; id: string } | { kind: 'empty' }

/**
 * Mirrors `getProjectCreatePolicy()`'s existing lookup pattern (routes.ts:321-326) exactly, per
 * this story's own Dev Notes — "reuse the pattern, do not invent a second one." Independent of
 * `getProjectCreatePolicy()`: a manifest declaring `'project-lifecycle'` but not
 * `'project-archive-notify'` (or vice versa) correctly yields `undefined` here.
 */
function getProjectArchiveNotifier(): ProjectArchiveNotifier | undefined {
  const extensionState = getExtensionStatus()
  if (extensionState.status !== 'loaded') return undefined
  if (!extensionState.manifest.capabilities.includes('project-archive-notify')) return undefined
  return extensionState.hooks.projectArchiveNotifier
}

/**
 * AC3 edge case — claims exactly one pending row via `SELECT ... FOR UPDATE SKIP LOCKED`, so an
 * overlapping worker run (e.g. multiple `apps/api` instances each running this worker) can never
 * claim and double-dispatch the SAME row concurrently. RLS (this call runs inside an
 * org-scoped `runOrgScopedJob` transaction) already restricts the row set to `orgId`'s own rows —
 * no explicit `org_id` filter is needed in the query itself for correctness, but the row is
 * always returned already known to belong to the calling `orgId` (AC4).
 *
 * `excludeIds` MUST list every row already dispatched earlier in the SAME poll cycle's batch
 * loop. A retried-but-still-`pending` row (timeout/throw, not yet at its attempt cap) stays
 * `status = 'pending'` after its own attempt — without this exclusion, the very next batch-loop
 * iteration (a brand new, separately-committed transaction, so the row's own claim lock has
 * already been released) would immediately re-claim and re-dispatch THAT SAME row again and
 * again within one poll cycle, racing its attempt count to the cap in one pass instead of
 * spreading retries across separate scheduled passes as intended.
 */
async function claimNextPendingRow(
  tx: Tx,
  excludeIds: readonly string[]
): Promise<PendingRow | undefined> {
  const exclusion =
    excludeIds.length > 0
      ? sql`AND id NOT IN (${sql.join(
          excludeIds.map((id) => sql`${id}::uuid`),
          sql`, `
        )})`
      : sql``
  const rows = await tx.execute<PendingRow>(sql`
    SELECT id::text AS id, project_id::text AS project_id, attempt_count
    FROM extension_lifecycle_events
    WHERE status = 'pending'
    ${exclusion}
    ORDER BY created_at
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  `)
  return rows[0]
}

async function markDelivered(tx: Tx, id: string): Promise<void> {
  await tx.execute(sql`
    UPDATE extension_lifecycle_events
    SET status = 'delivered', delivered_at = now(), last_attempt_at = now()
    WHERE id = ${id}::uuid
  `)
}

/** AC3's exhaustion edge case — increments attempt_count and records a fixed, non-leaking
 * failure reason (mirrors `logProjectLifecycleFailed`'s `'timed_out' | 'threw'` enum, never the
 * raw error message/stack); transitions to terminal `failed` once the bounded attempt cap is hit,
 * otherwise leaves the row `pending` for the next pass. */
async function markRetryOrFailed(
  tx: Tx,
  id: string,
  nextAttemptCount: number,
  lastError: 'timed_out' | 'threw'
): Promise<{ terminal: boolean }> {
  const terminal = nextAttemptCount >= EXTENSION_LIFECYCLE_NOTIFY_MAX_ATTEMPTS
  await tx.execute(sql`
    UPDATE extension_lifecycle_events
    SET attempt_count = ${nextAttemptCount},
        last_attempt_at = now(),
        last_error = ${lastError},
        status = ${terminal ? 'failed' : 'pending'}
    WHERE id = ${id}::uuid
  `)
  return { terminal }
}

/** AC3 (Security Audit Personas finding) — one structured log entry per dispatch ATTEMPT
 * (success, timeout, or thrown), not only terminal exhaustion. Never carries the hook's raw
 * exception message/stack. */
function logAttempt(
  logger: WorkerLogger,
  outcome: 'delivered' | 'delivered_no_extension' | 'timed_out' | 'threw',
  info: { orgId: string; projectId: string; attemptCount: number }
): void {
  operationalLog(
    logger,
    outcome === 'timed_out' || outcome === 'threw' ? 'warn' : 'info',
    OperationalEvent.EXTENSION_PROJECT_ARCHIVE_NOTIFY_ATTEMPT,
    'Extension project-archive-notify dispatch attempt',
    { outcome, ...info }
  )
}

function logExhausted(
  logger: WorkerLogger,
  info: { orgId: string; projectId: string; attemptCount: number }
): void {
  operationalLog(
    logger,
    'error',
    OperationalEvent.EXTENSION_PROJECT_ARCHIVE_NOTIFY_EXHAUSTED,
    'Extension project-archive-notify permanently failed after exhausting its attempt cap — the ' +
      'extension never learned this project archived',
    info
  )
}

/**
 * Claims and dispatches exactly one pending row for `orgId` in one org-scoped transaction — a
 * per-row (not per-batch) transaction, so a single slow dispatch never holds the claim lock on
 * more than the one row it is actively processing.
 */
async function claimAndDispatchOne(
  orgId: string,
  notifier: ProjectArchiveNotifier | undefined,
  logger: WorkerLogger,
  excludeIds: readonly string[]
): Promise<DispatchOutcome> {
  return runOrgScopedJob(orgId, EXTENSION_LIFECYCLE_NOTIFY_JOB_NAME, async ({ tx }) => {
    const row = await claimNextPendingRow(tx, excludeIds)
    if (!row) return { kind: 'empty' }

    if (!notifier) {
      // Design Decision 4 — no extension loaded, or the loaded extension does not declare
      // 'project-archive-notify': mark delivered immediately (a no-op success) rather than
      // leaving rows to accumulate forever with no consumer that could ever resolve them.
      await markDelivered(tx, row.id)
      logAttempt(logger, 'delivered_no_extension', {
        orgId,
        projectId: row.project_id,
        attemptCount: row.attempt_count,
      })
      return { kind: 'claimed', id: row.id }
    }

    const [fullRow] = await tx.execute<{ payload: ProjectArchivedContext }>(sql`
      SELECT payload FROM extension_lifecycle_events WHERE id = ${row.id}::uuid
    `)
    const payload = fullRow?.payload as ProjectArchivedContext

    const raced = await raceWithTimeout(
      () => notifier.onProjectArchived(payload),
      EXTENSION_CALLOUT_TIMEOUT_MS
    )

    if (raced.status === 'resolved') {
      await markDelivered(tx, row.id)
      logAttempt(logger, 'delivered', {
        orgId,
        projectId: row.project_id,
        attemptCount: row.attempt_count,
      })
      return { kind: 'claimed', id: row.id }
    }

    const outcome = raced.status === 'timed_out' ? 'timed_out' : 'threw'
    const nextAttemptCount = row.attempt_count + 1
    const { terminal } = await markRetryOrFailed(tx, row.id, nextAttemptCount, outcome)
    logAttempt(logger, outcome, {
      orgId,
      projectId: row.project_id,
      attemptCount: nextAttemptCount,
    })
    if (terminal) {
      logExhausted(logger, { orgId, projectId: row.project_id, attemptCount: nextAttemptCount })
    }
    return { kind: 'claimed', id: row.id }
  })
}

async function readOldestPendingAgeMs(tx: Tx): Promise<number | null> {
  const [row] = await tx.execute<{ oldest_created_at: Date | string | null }>(sql`
    SELECT MIN(created_at) AS oldest_created_at
    FROM extension_lifecycle_events
    WHERE status = 'pending'
  `)
  const oldest = row?.oldest_created_at
  if (!oldest) return null
  return Date.now() - new Date(oldest).getTime()
}

/** Dispatches up to `BATCH_SIZE_PER_ORG` pending rows for one org, then reports that org's own
 * oldest-remaining-pending-row age (or `null` if none remain). */
async function dispatchPendingEventsForOrg(
  orgId: string,
  notifier: ProjectArchiveNotifier | undefined,
  logger: WorkerLogger
): Promise<number | null> {
  const dispatchedIds: string[] = []
  while (dispatchedIds.length < BATCH_SIZE_PER_ORG) {
    const outcome = await claimAndDispatchOne(orgId, notifier, logger, dispatchedIds)
    if (outcome.kind === 'empty') break
    dispatchedIds.push(outcome.id)
  }
  return runOrgScopedJob(orgId, EXTENSION_LIFECYCLE_NOTIFY_JOB_NAME, ({ tx }) =>
    readOldestPendingAgeMs(tx)
  )
}

/**
 * Task 4 — the worker's own poll cycle: looks up the currently loaded extension's
 * `projectArchiveNotifier` hook ONCE per cycle (not once per row), then dispatches every org's
 * pending backlog (AC4 — always per-org RLS-scoped, never a single unscoped cross-org query).
 * Emits a per-poll-cycle "oldest pending row age" log line (Task 4 Operational Considerations) so
 * a systemic extension outage is visible before any individual row's own attempt cap is
 * exhausted.
 */
export async function runExtensionLifecycleNotify(logger: WorkerLogger): Promise<void> {
  const notifier = getProjectArchiveNotifier()
  const orgIds = await fetchAllOrgIds()

  let oldestPendingAgeMs: number | null = null
  for (const orgId of orgIds) {
    const orgOldestMs = await dispatchPendingEventsForOrg(orgId, notifier, logger)
    if (orgOldestMs !== null && (oldestPendingAgeMs === null || orgOldestMs > oldestPendingAgeMs)) {
      oldestPendingAgeMs = orgOldestMs
    }
  }

  operationalLog(
    logger,
    'info',
    OperationalEvent.EXTENSION_PROJECT_ARCHIVE_NOTIFY_POLL_CYCLE,
    'Extension project-archive-notify poll cycle completed',
    { oldestPendingRowAgeMs: oldestPendingAgeMs }
  )
}

export async function extensionLifecycleNotifyJobHandler(logger: WorkerLogger): Promise<void> {
  await withJobLogging(logger, EXTENSION_LIFECYCLE_NOTIFY_JOB_NAME, 'scheduled', () =>
    runExtensionLifecycleNotify(logger)
  )
}

/**
 * Task 4 Operational Considerations — `notification_queue` itself has no existing retention/
 * purge mechanism for `delivered`/`failed` rows to mirror (confirmed by repo-wide grep during
 * this story's implementation). This is a minimal periodic purge of THIS table's own resolved
 * rows only — deliberately not extended to `notification_queue`, which stays out of this story's
 * scope.
 */
export async function runExtensionLifecycleEventsPurge(logger: WorkerLogger): Promise<void> {
  const orgIds = await fetchAllOrgIds()
  let totalPurged = 0
  for (const orgId of orgIds) {
    const purged = await runOrgScopedJob(
      orgId,
      EXTENSION_LIFECYCLE_PURGE_JOB_NAME,
      async ({ tx }) => {
        const rows = await tx.execute<{ id: string }>(sql`
          DELETE FROM extension_lifecycle_events
          WHERE status IN ('delivered', 'failed')
            AND created_at < NOW() - (${RESOLVED_ROW_RETENTION_DAYS}::text || ' days')::interval
          RETURNING id
        `)
        return rows.length
      }
    )
    totalPurged += purged
  }
  if (totalPurged > 0) {
    operationalLog(
      logger,
      'info',
      OperationalEvent.JOB_COMPLETED,
      'Purged resolved extension_lifecycle_events rows past retention',
      { count: totalPurged, retentionDays: RESOLVED_ROW_RETENTION_DAYS }
    )
  }
}

export async function extensionLifecyclePurgeJobHandler(logger: WorkerLogger): Promise<void> {
  await withJobLogging(logger, EXTENSION_LIFECYCLE_PURGE_JOB_NAME, 'scheduled', () =>
    runExtensionLifecycleEventsPurge(logger)
  )
}
