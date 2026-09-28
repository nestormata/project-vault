import { sql } from 'drizzle-orm'
import { OperationalEvent } from '@project-vault/shared'
import { env } from '../config/env.js'
import type { BossService } from '../lib/boss.js'
import { operationalLog, serializeLogError } from '../lib/logger.js'
import { getOrCreateGauge } from '../lib/prom-client-registry.js'
import {
  clearThresholdAlertEpisode,
  listActiveThresholdAlertScopeKeys,
  upsertThresholdAlert,
} from '../lib/threshold-alerts.js'
import { fetchAllOrgIds, runOrgScopedJob } from '../middleware/rls.js'
import { deliverAdminAlertToPlatformOperator } from '../modules/backup/alerts.js'
import type { WorkerLogger } from './expiry-alert-shared.js'
import { getLoadedScheduledTaskExtension } from './extension-scheduled-tasks.js'
import {
  runAdvisoryLockedTick,
  runTickHandler,
  type DbTransaction,
} from './lib/job-tick-helpers.js'

/**
 * Story 56.2 — missed-tick watchdog for the `scheduled-task` extension hook (Story 56.1).
 *
 * A SEPARATE pg-boss job with its OWN advisory lock (never inside the tick job it watches — the
 * failure being detected is "the tick job isn't running / isn't reaching the handler", and a hung
 * tick holds the tick's lock). Every 5 minutes it evaluates each currently-declared
 * `(extensionId, taskName)` pair as Healthy / Grace / Missed from the per-org
 * `COALESCE(last_attempt_at, last_run_at)` bookkeeping 56.1's worker writes, and:
 * - Missed ⇒ one deduped `admin_alerts` episode per pair + one error log + one platform-operator
 *   notification per NEW episode;
 * - Healthy ⇒ resolves the pair's active episode (info log, no notification);
 * - Grace ⇒ nothing (this process has not watched a full window yet — never raises or resolves);
 * - pairs no longer declared ⇒ their active episodes are resolved and gauge series removed.
 * Any read failure that could hide recent attempts makes the evaluation inconclusive (AC5).
 *
 * Tenant isolation (AC6): no `getDb`/`getAdminDb` import here — the DB clock is read on the
 * advisory lock's own transaction, per-org reads go through `runOrgScopedJob` (RLS), and alert
 * rows go through the `threshold-alerts.ts`/`backup/alerts.ts` helpers. Alert/notification
 * payloads, gauge labels and the `/ready` token never carry org data.
 */

export const SCHEDULED_TASK_WATCHDOG_JOB_NAME = 'extension/scheduled-tasks-watchdog'
export const MISSED_ALERT_TYPE = 'extension_scheduled_task.missed'
/** Fixed floor (not env): absorbs 1-minute cron granularity, the 5-minute watchdog cadence and a
 * legitimately long tick (many 10 s callout timeouts at concurrency 20). */
export const MIN_MISSED_WINDOW_MINUTES = 10

const MS_PER_MINUTE = 60_000

type PairState = 'healthy' | 'grace' | 'missed'

export type EvaluatePairInput = {
  intervalMinutes: number
  latestAttemptAt: Date | null
  armedAt: Date
  dbNow: Date
  orgCount: number
  missedTickThreshold: number
}

/**
 * Pure three-state evaluation (see the story's Terminology). Only positive evidence (a recent
 * attempt, or zero orgs expected to fire) is Healthy; absence of evidence before this process has
 * watched a full window is Grace. AC5's partial-read downgrade is applied by the caller.
 */
export function evaluatePair(input: EvaluatePairInput): {
  state: PairState
  windowMinutes: number
} {
  const windowMinutes = Math.max(
    input.missedTickThreshold * input.intervalMinutes,
    MIN_MISSED_WINDOW_MINUTES
  )
  const windowMs = windowMinutes * MS_PER_MINUTE
  const nowMs = input.dbNow.getTime()

  if (input.orgCount === 0) return { state: 'healthy', windowMinutes }
  if (input.latestAttemptAt && nowMs - input.latestAttemptAt.getTime() <= windowMs) {
    return { state: 'healthy', windowMinutes }
  }
  if (nowMs - input.armedAt.getTime() <= windowMs) return { state: 'grace', windowMinutes }
  return { state: 'missed', windowMinutes }
}

/** DB-clock `now()` of this process's first lock-acquiring watchdog tick (Grace baseline). */
let watchdogArmedAt: Date | undefined

export function __resetWatchdogArmedAtForTests(): void {
  watchdogArmedAt = undefined
}

const missedGauge = getOrCreateGauge({
  name: 'extension_scheduled_task_missed',
  help: '1 while a declared extension scheduled task has an active missed-tick episode (Story 56.2), 0 otherwise. Per-process: reflects the last watchdog tick this process ran; admin_alerts is authoritative.',
  labelNames: ['extension_id', 'task_name'] as const,
})

type MissedAlertPayload = {
  extensionId: string
  taskName: string
  intervalMinutes: number
  windowMinutes: number
  missedTickThreshold: number
  lastAttemptAt: string | null
}

export type ScheduledTaskWatchdogDeps = {
  boss?: BossService
  fetchOrgIds?: () => Promise<string[]>
  readDbNow?: (lockTx: DbTransaction) => Promise<Date>
  missedTickThreshold?: number
  deliverToOperator?: (payload: MissedAlertPayload) => Promise<void>
  /** Test seams for AC5/T12, T13, T26 failure paths — production uses the real helpers. */
  readOrgLatestAttempts?: (orgId: string, extensionId: string) => Promise<Map<string, Date>>
  upsertAlert?: typeof upsertThresholdAlert
  listActiveScopeKeys?: (alertType: string) => Promise<string[]>
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}

async function readDbNowOnLockTx(lockTx: DbTransaction): Promise<Date> {
  const rows = await lockTx.execute<{ now: Date | string }>(sql`SELECT now() AS now`)
  const now = rows[0]?.now
  if (now === undefined) throw new Error('SELECT now() returned no row')
  return toDate(now)
}

/**
 * One org's latest attempt per task for `extensionId`, read under that org's RLS context
 * (FORCE RLS on `extension_scheduled_task_runs`) — rows of other orgs are never visible here.
 */
export async function readOrgLatestAttempts(
  orgId: string,
  extensionId: string
): Promise<Map<string, Date>> {
  return runOrgScopedJob(orgId, SCHEDULED_TASK_WATCHDOG_JOB_NAME, async ({ tx }) => {
    const rows = await tx.execute<{ task_name: string; latest: Date | string | null }>(sql`
      SELECT task_name, max(COALESCE(last_attempt_at, last_run_at)) AS latest
        FROM extension_scheduled_task_runs
       WHERE extension_id = ${extensionId}
       GROUP BY task_name
    `)
    const latest = new Map<string, Date>()
    for (const row of rows) {
      if (row.latest !== null) latest.set(row.task_name, toDate(row.latest))
    }
    return latest
  })
}

function logInconclusive(
  logger: WorkerLogger | undefined,
  fields: Record<string, unknown> & { reason: string }
): void {
  if (!logger) return
  operationalLog(
    logger,
    'warn',
    OperationalEvent.EXTENSION_SCHEDULED_TASK_WATCHDOG_INCONCLUSIVE,
    'scheduled-task watchdog evaluation inconclusive',
    fields
  )
}

type AttemptAggregate = { latestByTask: Map<string, Date>; failedOrgCount: number }

/** Folds each org's per-task latest attempt into one max per task; per-org failures are logged
 * and counted, never thrown. */
async function aggregateLatestAttempts(
  orgIds: string[],
  extensionId: string,
  readOrg: NonNullable<ScheduledTaskWatchdogDeps['readOrgLatestAttempts']>,
  logger: WorkerLogger | undefined
): Promise<AttemptAggregate> {
  const latestByTask = new Map<string, Date>()
  let failedOrgCount = 0
  for (const orgId of orgIds) {
    try {
      const orgLatest = await readOrg(orgId, extensionId)
      for (const [taskName, at] of orgLatest) {
        const current = latestByTask.get(taskName)
        if (!current || at > current) latestByTask.set(taskName, at)
      }
    } catch (error) {
      failedOrgCount += 1
      logInconclusive(logger, { reason: 'org_read_failed', orgId, err: serializeLogError(error) })
    }
  }
  return { latestByTask, failedOrgCount }
}

type TickContext = {
  logger: WorkerLogger | undefined
  deps: ScheduledTaskWatchdogDeps
  activeScopeKeys: Set<string>
  dbNow: Date
  armedAt: Date
  orgCount: number
  missedTickThreshold: number
  aggregate: AttemptAggregate
  extensionId: string
}

function scopeKeyOf(extensionId: string, taskName: string): string {
  return `${extensionId}/${taskName}`
}

async function deliverMissedAlert(ctx: TickContext, payload: MissedAlertPayload): Promise<void> {
  const { boss, deliverToOperator } = ctx.deps
  const deliver =
    deliverToOperator ??
    (boss
      ? (p: MissedAlertPayload) =>
          deliverAdminAlertToPlatformOperator(boss, MISSED_ALERT_TYPE, p, 'warning')
      : undefined)
  if (!deliver) return // no boss (tests / degraded boot): row + log + gauge still happen
  try {
    await deliver(payload)
  } catch (error) {
    if (ctx.logger) {
      operationalLog(
        ctx.logger,
        'warn',
        OperationalEvent.EXTENSION_SCHEDULED_TASK_MISSED_ALERT_DISPATCH_FAILED,
        'extension scheduled task missed alert dispatch failed',
        {
          extensionId: payload.extensionId,
          taskName: payload.taskName,
          err: serializeLogError(error),
        }
      )
    }
  }
}

async function raiseMissed(ctx: TickContext, payload: MissedAlertPayload): Promise<void> {
  const upsert = ctx.deps.upsertAlert ?? upsertThresholdAlert
  const created = await upsert({
    alertType: MISSED_ALERT_TYPE,
    thresholdPct: 80,
    severity: 'warning',
    scopeKey: scopeKeyOf(payload.extensionId, payload.taskName),
    payload,
  })
  if (!created) return // episode already active — no re-log, no re-notification

  if (ctx.logger) {
    operationalLog(
      ctx.logger,
      'error',
      OperationalEvent.EXTENSION_SCHEDULED_TASK_MISSED,
      'extension scheduled task missed expected ticks',
      {
        extensionId: payload.extensionId,
        taskName: payload.taskName,
        intervalMinutes: payload.intervalMinutes,
        windowMinutes: payload.windowMinutes,
        lastAttemptAt: payload.lastAttemptAt,
      }
    )
  }
  await deliverMissedAlert(ctx, payload)
}

/** Resolves an episode only when one is actually active (the active set is the check, since
 * `clearThresholdAlertEpisode` returns void) so the info log marks a real transition. */
async function resolveIfActive(
  ctx: TickContext,
  extensionId: string,
  taskName: string,
  reason: 'healthy' | 'no_longer_declared'
): Promise<void> {
  const scopeKey = scopeKeyOf(extensionId, taskName)
  if (!ctx.activeScopeKeys.has(scopeKey)) return
  await clearThresholdAlertEpisode(MISSED_ALERT_TYPE, scopeKey)
  if (ctx.logger) {
    operationalLog(
      ctx.logger,
      'info',
      OperationalEvent.EXTENSION_SCHEDULED_TASK_MISSED_RESOLVED,
      'extension scheduled task missed alert resolved',
      { extensionId, taskName, reason }
    )
  }
}

async function evaluateDeclaredPair(
  ctx: TickContext,
  taskName: string,
  intervalMinutes: number
): Promise<void> {
  const { extensionId } = ctx
  const labels = { extension_id: extensionId, task_name: taskName }
  const latestAttemptAt = ctx.aggregate.latestByTask.get(taskName) ?? null
  const { state, windowMinutes } = evaluatePair({
    intervalMinutes,
    latestAttemptAt,
    armedAt: ctx.armedAt,
    dbNow: ctx.dbNow,
    orgCount: ctx.orgCount,
    missedTickThreshold: ctx.missedTickThreshold,
  })

  if (state === 'healthy') {
    await resolveIfActive(ctx, extensionId, taskName, 'healthy')
    missedGauge.set(labels, 0)
    return
  }
  if (state === 'grace') {
    missedGauge.set(labels, ctx.activeScopeKeys.has(scopeKeyOf(extensionId, taskName)) ? 1 : 0)
    return
  }
  if (ctx.aggregate.failedOrgCount > 0) {
    // The failed orgs may hold this pair's recent attempts — never page on partial evidence.
    logInconclusive(ctx.logger, {
      reason: 'partial_org_reads_missed_unconfirmed',
      extensionId,
      taskName,
      failedOrgCount: ctx.aggregate.failedOrgCount,
    })
    return
  }
  await raiseMissed(ctx, {
    extensionId,
    taskName,
    intervalMinutes,
    windowMinutes,
    missedTickThreshold: ctx.missedTickThreshold,
    lastAttemptAt: latestAttemptAt ? latestAttemptAt.toISOString() : null,
  })
  missedGauge.set(labels, 1)
}

function logEvaluationFailed(
  logger: WorkerLogger | undefined,
  extensionId: string,
  taskName: string,
  error: unknown
): void {
  if (!logger) return
  operationalLog(
    logger,
    'error',
    OperationalEvent.EXTENSION_SCHEDULED_TASK_WATCHDOG_EVALUATION_FAILED,
    'scheduled-task watchdog evaluation failed for pair',
    { extensionId, taskName, err: serializeLogError(error) }
  )
}

/** AC4b — active episodes whose pair is no longer declared (task removed, extension replaced or
 * unloaded) are resolved and their gauge series removed so no stale `1` lingers. */
async function resolveUndeclared(ctx: TickContext, declaredScopeKeys: Set<string>): Promise<void> {
  for (const scopeKey of ctx.activeScopeKeys) {
    if (declaredScopeKeys.has(scopeKey)) continue
    const separator = scopeKey.indexOf('/')
    const extensionId = scopeKey.slice(0, separator)
    const taskName = scopeKey.slice(separator + 1)
    try {
      await resolveIfActive(ctx, extensionId, taskName, 'no_longer_declared')
      missedGauge.remove({ extension_id: extensionId, task_name: taskName })
    } catch (error) {
      logEvaluationFailed(ctx.logger, extensionId, taskName, error)
    }
  }
}

async function readTickInputs(
  logger: WorkerLogger | undefined,
  deps: ScheduledTaskWatchdogDeps
): Promise<{ activeScopeKeys: Set<string>; orgIds: string[] } | undefined> {
  let activeScopeKeys: Set<string>
  try {
    const listActive = deps.listActiveScopeKeys ?? listActiveThresholdAlertScopeKeys
    activeScopeKeys = new Set(await listActive(MISSED_ALERT_TYPE))
  } catch (error) {
    logInconclusive(logger, { reason: 'active_alerts_read_failed', err: serializeLogError(error) })
    return undefined
  }
  try {
    const orgIds = await (deps.fetchOrgIds ?? fetchAllOrgIds)()
    return { activeScopeKeys, orgIds }
  } catch (error) {
    logInconclusive(logger, { reason: 'org_list_failed', err: serializeLogError(error) })
    return undefined
  }
}

/**
 * Reads the loaded extension's per-task latest attempts across every org. Returns `undefined`
 * (after the AC5 `all_org_reads_failed` log) when every org read failed — the whole evaluation is
 * then inconclusive. No loaded extension or zero orgs ⇒ nothing to read (empty aggregate).
 */
async function readDeclaredAttempts(
  extensionId: string | undefined,
  orgIds: string[],
  deps: ScheduledTaskWatchdogDeps,
  logger: WorkerLogger | undefined
): Promise<AttemptAggregate | undefined> {
  if (extensionId === undefined || orgIds.length === 0) {
    return { latestByTask: new Map<string, Date>(), failedOrgCount: 0 }
  }
  const aggregate = await aggregateLatestAttempts(
    orgIds,
    extensionId,
    deps.readOrgLatestAttempts ?? readOrgLatestAttempts,
    logger
  )
  if (aggregate.failedOrgCount === orgIds.length) {
    logInconclusive(logger, { reason: 'all_org_reads_failed', orgCount: orgIds.length })
    return undefined
  }
  return aggregate
}

async function evaluateDeclaredPairs(
  ctx: TickContext,
  declared: Array<[string, number]>
): Promise<void> {
  for (const [taskName, intervalMinutes] of declared) {
    try {
      await evaluateDeclaredPair(ctx, taskName, intervalMinutes)
    } catch (error) {
      logEvaluationFailed(ctx.logger, ctx.extensionId, taskName, error)
    }
  }
}

async function runWatchdogBody(
  lockTx: DbTransaction,
  logger: WorkerLogger | undefined,
  deps: ScheduledTaskWatchdogDeps
): Promise<void> {
  const dbNow = await (deps.readDbNow ?? readDbNowOnLockTx)(lockTx)
  watchdogArmedAt ??= dbNow // armed even if this tick turns out inconclusive (only shortens Grace)
  const armedAt = watchdogArmedAt

  const inputs = await readTickInputs(logger, deps)
  if (!inputs) return

  const loaded = getLoadedScheduledTaskExtension()
  const aggregate = await readDeclaredAttempts(loaded?.extensionId, inputs.orgIds, deps, logger)
  if (!aggregate) return

  const declared = loaded ? [...loaded.taskIntervalMinutes] : []
  const extensionId = loaded?.extensionId ?? ''
  const ctx: TickContext = {
    logger,
    deps,
    activeScopeKeys: inputs.activeScopeKeys,
    dbNow,
    armedAt,
    orgCount: inputs.orgIds.length,
    missedTickThreshold: deps.missedTickThreshold ?? env.SCHEDULED_TASK_MISSED_TICK_THRESHOLD,
    aggregate,
    extensionId,
  }
  await evaluateDeclaredPairs(ctx, declared)
  await resolveUndeclared(
    ctx,
    new Set(declared.map(([taskName]) => scopeKeyOf(extensionId, taskName)))
  )
}

export async function runScheduledTaskWatchdogTick(
  logger?: WorkerLogger,
  deps: ScheduledTaskWatchdogDeps = {}
): Promise<void> {
  await runAdvisoryLockedTick(
    SCHEDULED_TASK_WATCHDOG_JOB_NAME,
    logger,
    OperationalEvent.EXTENSION_SCHEDULED_TASK_WATCHDOG_TICK_SKIPPED_OVERLAP,
    'scheduled-task watchdog tick skipped — previous watchdog tick still running',
    (lockTx) => runWatchdogBody(lockTx, logger, deps)
  )
}

export async function scheduledTaskWatchdogTickHandler(
  boss: BossService | undefined,
  logger?: WorkerLogger
): Promise<void> {
  await runTickHandler(SCHEDULED_TASK_WATCHDOG_JOB_NAME, () =>
    runScheduledTaskWatchdogTick(logger, { boss })
  )
}
