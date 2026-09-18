import { performance } from 'node:perf_hooks'
import { sql } from 'drizzle-orm'
import { getDb } from '@project-vault/db'
import { extensionScheduledTaskRuns } from '@project-vault/db/schema'
import { OperationalEvent } from '@project-vault/shared'
import type { HostServices, ScheduledTaskContext } from '@project-vault/extension-api'
import { env } from '../config/env.js'
import { fetchAllOrgIds, runOrgScopedJob } from '../middleware/rls.js'
import { getExtensionStatus } from '../extensions/loader.js'
import { raceWithTimeout } from '../lib/race-with-timeout.js'
import { EXTENSION_CALLOUT_TIMEOUT_MS } from '../lib/extension-callout-timeout.js'
import { operationalLog, serializeLogError } from '../lib/logger.js'
import { runWithConcurrencyLimit } from './monitoring-health-check.js'
import type { WorkerLogger } from './expiry-alert-shared.js'

/**
 * Story 56.1 Task 4 — background job runner invoking the `scheduled-task` extension hook once
 * per active org, on each declared task's manifest-declared interval. Mirrors
 * `monitoring-health-check.ts`'s own structure exactly: outer non-blocking advisory lock (at most
 * one tick at a time), per-org RLS-scoped due-query, bounded concurrency, per-tuple
 * try/catch-log-continue failure isolation (AC2).
 *
 * Deliberately does NOT touch `apps/api/src/lib/monitoring-host.ts`,
 * `packages/extension-api/src/host-services.ts`'s `monitoring` namespace, or
 * `apps/api/src/workers/monitoring-health-check.ts` — those were already out-of-request-capable
 * (this story's own scope-correction finding) and are explicitly out of scope here.
 */

export const JOB_NAME = 'extension/scheduled-tasks'
const ADVISORY_LOCK_NAME = 'extension/scheduled-tasks'

type DueTuple = { orgId: string; taskName: string }

type LoadedScheduledTaskExtension = {
  extensionId: string
  taskIntervalMinutes: Map<string, number>
  hostServices: HostServices
  invoke: (context: ScheduledTaskContext) => Promise<void>
}

/**
 * Resolves the currently-loaded extension's scheduled-task surface fresh — called both when
 * building the tick's due-tuple list AND again, individually, immediately before each invocation
 * (AC1's uninstall-race edge case: the loader's module-level state may have changed between the
 * two calls, e.g. the extension failed/reloaded). Returns `undefined` for every non-eligible
 * case: no extension loaded, capability not declared, zero declared tasks (pre-existing extension
 * migration-compatibility case), or hooksFactory() returned no callable handler (should never
 * happen — `registerExtension()` already rejects this shape — but never assumed).
 */
function getLoadedScheduledTaskExtension(): LoadedScheduledTaskExtension | undefined {
  const state = getExtensionStatus()
  if (state.status !== 'loaded') return undefined
  if (!state.manifest.capabilities.includes('scheduled-task')) return undefined
  if (!state.manifest.scheduledTasks || state.manifest.scheduledTasks.length === 0) {
    return undefined
  }
  if (!state.hostServices) return undefined
  const onScheduledTask = state.hooks.scheduledTask?.onScheduledTask
  if (typeof onScheduledTask !== 'function') return undefined

  const hostServices = state.hostServices
  return {
    extensionId: state.manifest.name,
    taskIntervalMinutes: new Map(
      state.manifest.scheduledTasks.map((task) => [task.name, task.intervalMinutes])
    ),
    hostServices,
    invoke: (context) => onScheduledTask(context),
  }
}

/**
 * Task 3 — the due-tuple query for a single org: joins the extension's manifest-declared
 * `(taskName, intervalMinutes)` pairs against this org's own `extension_scheduled_task_runs` rows
 * (RLS-scoped via `runOrgScopedJob`), using the DATABASE SERVER's clock (`now()`) for every
 * due-check comparison — never application wall-clock time, per Task 3's explicit requirement.
 * `lastRunAt IS NULL` (never run) or elapsed-beyond-interval both count as due.
 */
export async function fetchDueTaskNames(
  orgId: string,
  extensionId: string,
  taskIntervalMinutes: Map<string, number>
): Promise<string[]> {
  const declared = [...taskIntervalMinutes.entries()]
  if (declared.length === 0) return []

  return runOrgScopedJob(orgId, JOB_NAME, async ({ tx }) => {
    const valuesList = sql.join(
      declared.map(
        ([taskName, intervalMinutes]) => sql`(${taskName}::text, ${intervalMinutes}::int)`
      ),
      sql`, `
    )
    const rows = await tx.execute<{ task_name: string }>(sql`
      WITH declared(task_name, interval_minutes) AS (VALUES ${valuesList})
      SELECT d.task_name
        FROM declared d
        LEFT JOIN extension_scheduled_task_runs r
          ON r.extension_id = ${extensionId} AND r.task_name = d.task_name
       WHERE r.last_run_at IS NULL
          OR r.last_run_at <= now() - (d.interval_minutes || ' minutes')::interval
    `)
    return rows.map((row) => row.task_name)
  })
}

/** Collects every due `(org, task)` tuple across every existing org — per-org query failures are
 * logged and skipped (never abort the whole tick), same posture as
 * `monitoring-health-check.ts`'s own per-org due-query failure handling. */
async function collectDueTuples(
  loaded: LoadedScheduledTaskExtension,
  logger: WorkerLogger | undefined
): Promise<DueTuple[]> {
  const orgIds = await fetchAllOrgIds()
  const dueTuples: DueTuple[] = []
  for (const orgId of orgIds) {
    try {
      const dueTaskNames = await fetchDueTaskNames(
        orgId,
        loaded.extensionId,
        loaded.taskIntervalMinutes
      )
      for (const taskName of dueTaskNames) dueTuples.push({ orgId, taskName })
    } catch (error) {
      if (logger) {
        operationalLog(
          logger,
          'error',
          OperationalEvent.EXTENSION_SCHEDULED_TASK_INVOKED,
          'scheduled-task due-query failed for org',
          { orgId, extensionId: loaded.extensionId, err: serializeLogError(error) }
        )
      }
    }
  }
  return dueTuples
}

function logInvocation(
  logger: WorkerLogger | undefined,
  tuple: DueTuple,
  extensionId: string,
  outcome: 'success' | 'failure',
  durationMs: number,
  error?: unknown
): void {
  if (!logger) return
  operationalLog(
    logger,
    outcome === 'success' ? 'info' : 'error',
    OperationalEvent.EXTENSION_SCHEDULED_TASK_INVOKED,
    'extension scheduled-task invocation recorded',
    {
      extensionId,
      taskName: tuple.taskName,
      organizationId: tuple.orgId,
      outcome,
      durationMs,
      ...(error !== undefined ? { err: serializeLogError(error) } : {}),
    }
  )
}

/** AC2 — updates `lastRunAt`/`lastOutcome` ONLY on a successful invocation (the tuple's row is
 * otherwise left stale, so it stays "due" and is retried on the next qualifying tick). A failure
 * to persist this success is logged but never rethrown — the extension's own work already
 * completed; losing the due-state bookkeeping just means one extra (harmless) re-invocation next
 * tick, not a correctness issue for the extension's own side effects. */
async function recordSuccess(
  tuple: DueTuple,
  extensionId: string,
  logger: WorkerLogger | undefined
): Promise<void> {
  try {
    await runOrgScopedJob(tuple.orgId, JOB_NAME, async ({ tx }) => {
      await tx
        .insert(extensionScheduledTaskRuns)
        .values({
          orgId: tuple.orgId,
          extensionId,
          taskName: tuple.taskName,
          lastRunAt: sql`now()`,
          lastOutcome: 'success',
        })
        .onConflictDoUpdate({
          target: [
            extensionScheduledTaskRuns.extensionId,
            extensionScheduledTaskRuns.taskName,
            extensionScheduledTaskRuns.orgId,
          ],
          set: { lastRunAt: sql`now()`, lastOutcome: 'success', updatedAt: sql`now()` },
        })
    })
  } catch (error) {
    if (logger) {
      operationalLog(
        logger,
        'error',
        OperationalEvent.EXTENSION_SCHEDULED_TASK_INVOKED,
        'failed to persist scheduled-task success due-state',
        {
          extensionId,
          taskName: tuple.taskName,
          organizationId: tuple.orgId,
          err: serializeLogError(error),
        }
      )
    }
  }
}

/**
 * AC1's uninstall-race edge case + AC2's per-tuple isolation, both handled here: re-resolves the
 * loaded extension fresh (not the snapshot `collectDueTuples` used) immediately before invoking,
 * skipping (not erroring) if the extension/task is no longer eligible; wraps the real invocation
 * in a bounded timeout and never lets one tuple's failure escape to the concurrency runner.
 *
 * Exported (not test-prefixed, mirroring `probeServiceEndpoint`/`fetchDueServiceEndpoints`'s own
 * exported-for-direct-testing precedent in `monitoring-health-check.ts`) so the AC1 uninstall-race
 * behavior can be exercised directly and deterministically: set the extension state AFTER the due
 * tuple would have been selected but BEFORE calling this function, which is exactly the race
 * window `runScheduledTasksTick` cannot be made to hit deterministically end-to-end.
 */
export async function invokeOneTask(
  tuple: DueTuple,
  expectedExtensionId: string,
  logger: WorkerLogger | undefined
): Promise<void> {
  const start = performance.now()
  try {
    const fresh = getLoadedScheduledTaskExtension()
    if (
      !fresh ||
      fresh.extensionId !== expectedExtensionId ||
      !fresh.taskIntervalMinutes.has(tuple.taskName)
    ) {
      return // uninstalled/reloaded between due-tuple selection and invocation — skip, not an error
    }

    const context: ScheduledTaskContext = {
      organizationId: tuple.orgId,
      taskName: tuple.taskName,
      hostServices: fresh.hostServices,
    }

    const raced = await raceWithTimeout(() => fresh.invoke(context), EXTENSION_CALLOUT_TIMEOUT_MS)
    const durationMs = Math.round(performance.now() - start)

    if (raced.status === 'resolved') {
      await recordSuccess(tuple, expectedExtensionId, logger)
      logInvocation(logger, tuple, expectedExtensionId, 'success', durationMs)
      return
    }

    const error =
      raced.status === 'rejected' ? raced.error : new Error('scheduled-task invocation timed out')
    logInvocation(logger, tuple, expectedExtensionId, 'failure', durationMs, error)
  } catch (error) {
    // Defense in depth — invoke()/recordSuccess() already catch their own failure modes, but a
    // genuinely unexpected throw here must still never escape to runWithConcurrencyLimit (AC2).
    logInvocation(
      logger,
      tuple,
      expectedExtensionId,
      'failure',
      Math.round(performance.now() - start),
      error
    )
  }
}

/**
 * A single global tick — mirrors `monitoring-health-check.ts`'s `runHealthCheckTick` exactly:
 * non-blocking advisory lock guarantees at most one tick runs at a time; collects due tuples
 * across every org, then invokes them under one bounded concurrency limit (sized so a handful of
 * perpetually-failing tuples — AC2's accepted no-backoff behavior — cannot starve every other due
 * tuple of a concurrency slot every tick, Task 4's sizing note).
 */
export async function runScheduledTasksTick(logger?: WorkerLogger): Promise<void> {
  await getDb().transaction(async (lockTx) => {
    const lockRows = await lockTx.execute<{ locked: boolean }>(
      sql`SELECT pg_try_advisory_xact_lock(hashtext(${ADVISORY_LOCK_NAME})) AS locked`
    )
    const acquired = Boolean(lockRows[0]?.locked)
    if (!acquired) {
      if (logger) {
        operationalLog(
          logger,
          'warn',
          OperationalEvent.EXTENSION_SCHEDULED_TASK_TICK_SKIPPED_OVERLAP,
          'scheduled-task tick skipped — previous tick still running',
          {}
        )
      }
      return
    }

    const loaded = getLoadedScheduledTaskExtension()
    if (!loaded) return // no-op: no extension loaded, capability not declared, or zero declared tasks

    const dueTuples = await collectDueTuples(loaded, logger)
    await runWithConcurrencyLimit(dueTuples, env.SCHEDULED_TASK_MAX_CONCURRENCY, (tuple) =>
      invokeOneTask(tuple, loaded.extensionId, logger)
    )
  })
}

export async function scheduledTasksTickHandler(logger?: WorkerLogger): Promise<void> {
  try {
    await runScheduledTasksTick(logger)
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ eventType: 'job.failed', job: JOB_NAME, error: error instanceof Error ? error.message : String(error) })}\n`
    )
    throw error
  }
}
