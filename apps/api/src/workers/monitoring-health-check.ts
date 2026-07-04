import { performance } from 'node:perf_hooks'
import { sql } from 'drizzle-orm'
import { getDb } from '@project-vault/db'
import { serviceEndpoints } from '@project-vault/db/schema'
import { OperationalEvent } from '@project-vault/shared'
import type { Dispatcher } from 'undici'
import { env } from '../config/env.js'
import { fetchAllOrgIds, runOrgScopedJob } from '../middleware/rls.js'
import {
  createOrgAdminNotificationEntries,
  sendNotificationJobs,
  type NotificationQueueJob,
} from '../notifications/dispatcher.js'
import type { BossService } from '../lib/boss.js'
import { operationalLog, serializeLogError } from '../lib/logger.js'
import {
  applyHealthCheckResult,
  createMonitoringAlertIfNotDeduped,
  serializeServiceEndpoint,
  writeSystemAuditRow,
  UrlNotMonitorableError,
} from '../modules/monitoring/service.js'
import {
  assertUrlIsMonitorable,
  createSsrfSafeDispatcher,
} from '../modules/monitoring/url-safety.js'
import type { WorkerLogger } from './expiry-alert-shared.js'

const JOB_NAME = 'monitoring/health-check'
const ADVISORY_LOCK_NAME = 'monitoring/health-check'
const HEALTH_CHECK_TIMEOUT_MS = 10_000
const MAX_REDIRECT_HOPS = 5

export type ProbeFailureReason = 'timeout' | 'http_error' | 'network_error' | 'ssrf_blocked'
export type ProbeResult = {
  isHealthy: boolean
  statusCode: number | null
  latencyMs: number
  failureReason: ProbeFailureReason | null
}

function elapsedMs(start: number): number {
  return Math.round(performance.now() - start)
}

/** ADR-6.2-08: undici wraps a connect-time throw as `TypeError('fetch failed', { cause })` — the
 * dispatcher's own connect-time SSRF re-validation surfaces this way, not as a plain network
 * error, so it must be distinguished to set the correct failureReason (ADR-6.2-12). */
function isSsrfBlockedCause(error: unknown): boolean {
  if (error instanceof UrlNotMonitorableError) return true
  const cause = (error as { cause?: unknown } | undefined)?.cause
  return cause instanceof UrlNotMonitorableError
}

function resolveRedirectTarget(location: string, currentUrl: string): string {
  return new URL(location, currentUrl).toString()
}

function failureResult(start: number, failureReason: ProbeFailureReason): ProbeResult {
  return { isHealthy: false, statusCode: null, latencyMs: elapsedMs(start), failureReason }
}

type HopOutcome = { kind: 'final'; result: ProbeResult } | { kind: 'redirect'; location: string }

/** Performs a single request in the probe's redirect chain and classifies its outcome. */
async function fetchHop(
  currentUrl: string,
  controller: AbortController,
  dispatcher: Dispatcher,
  start: number
): Promise<HopOutcome> {
  let response: Response
  try {
    response = await fetch(currentUrl, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      dispatcher,
    } as never)
  } catch (error) {
    if (controller.signal.aborted) return { kind: 'final', result: failureResult(start, 'timeout') }
    const reason = isSsrfBlockedCause(error) ? 'ssrf_blocked' : 'network_error'
    return { kind: 'final', result: failureResult(start, reason) }
  }

  const location = response.headers.get('location')
  if (response.status >= 300 && response.status < 400 && location) {
    return { kind: 'redirect', location }
  }

  const isHealthy = response.status >= 200 && response.status < 300
  return {
    kind: 'final',
    result: {
      isHealthy,
      statusCode: response.status,
      latencyMs: elapsedMs(start),
      failureReason: isHealthy ? null : 'http_error',
    },
  }
}

/**
 * AC 4, ADR-6.2-08: performs the HTTP probe with a single 10-second budget covering the whole
 * request chain, following redirects manually (never `redirect: 'follow'`) with each hop
 * re-validated via `assertUrlIsMonitorable` before being followed, through the pinned
 * SSRF-safe dispatcher. Never stores the response body — only status/latency/result (AC 4).
 * Allows up to MAX_REDIRECT_HOPS redirects (i.e. up to MAX_REDIRECT_HOPS + 1 total requests);
 * a chain still redirecting past that is a failure (AC 4's "redirect limit exceeded" case).
 */
export async function probeServiceEndpoint(
  startUrl: string,
  dispatcher: Dispatcher
): Promise<ProbeResult> {
  const start = performance.now()
  const controller = new AbortController()
  const timeoutHandle = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS)

  try {
    let currentUrl = startUrl
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECT_HOPS; redirectCount++) {
      if (redirectCount > 0) {
        try {
          await assertUrlIsMonitorable(currentUrl)
        } catch {
          return failureResult(start, 'ssrf_blocked')
        }
      }

      const outcome = await fetchHop(currentUrl, controller, dispatcher, start)
      if (outcome.kind === 'final') return outcome.result
      currentUrl = resolveRedirectTarget(outcome.location, currentUrl)
    }
    return failureResult(start, 'network_error') // chain exceeded MAX_REDIRECT_HOPS
  } finally {
    clearTimeout(timeoutHandle)
  }
}

/** Small in-house bounded-concurrency runner (ADR-6.2-09) — no new dependency needed for this. */
export async function runWithConcurrencyLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let index = 0
  async function worker(): Promise<void> {
    while (index < items.length) {
      const current = items[index]
      index += 1
      if (current !== undefined) await fn(current)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
}

type ServiceEndpointRow = typeof serviceEndpoints.$inferSelect

async function fetchDueServiceEndpoints(orgId: string): Promise<ServiceEndpointRow[]> {
  return runOrgScopedJob(orgId, JOB_NAME, ({ tx }) =>
    tx
      .select()
      .from(serviceEndpoints)
      .where(
        sql`${serviceEndpoints.lastCheckedAt} IS NULL OR ${serviceEndpoints.lastCheckedAt} <= now() - (${serviceEndpoints.checkFrequencyMinutes} || ' minutes')::interval`
      )
  )
}

/** The endpoint context shared by the stored alert-row payload and the notification payload. */
function endpointAlertContext(endpoint: ServiceEndpointRow): Record<string, unknown> {
  const serialized = serializeServiceEndpoint(endpoint)
  return {
    serviceEndpointId: endpoint.id,
    serviceEndpointName: endpoint.name,
    url: serialized.url, // ADR-6.2-11: already redacted
    projectId: endpoint.projectId,
  }
}

async function processDueEndpoint(
  orgId: string,
  endpoint: ServiceEndpointRow,
  dispatcher: Dispatcher,
  logger: WorkerLogger | undefined
): Promise<NotificationQueueJob[]> {
  try {
    const probe = await probeServiceEndpoint(endpoint.url, dispatcher)

    return await runOrgScopedJob(orgId, JOB_NAME, async ({ tx }) => {
      const { alertFired, episodeKey, updatedRow } = await applyHealthCheckResult(tx, {
        serviceEndpoint: endpoint,
        isHealthy: probe.isHealthy,
        statusCode: probe.statusCode,
        latencyMs: probe.latencyMs,
        failureReason: probe.failureReason,
      })

      if (!alertFired || !episodeKey) return []

      const severity = alertFired === 'service.down' ? 'critical' : 'info'
      const alert = await createMonitoringAlertIfNotDeduped(tx, {
        orgId,
        projectId: endpoint.projectId,
        serviceEndpointId: endpoint.id,
        alertType: alertFired,
        severity,
        episodeKey,
        payload: endpointAlertContext(updatedRow),
      })
      if (!alert) return [] // deduped (ADR-6.2-05) or dedup lock lost the race

      await writeSystemAuditRow(tx, {
        orgId,
        eventType: alertFired,
        resourceId: alert.id,
        payload: { serviceEndpointId: endpoint.id, alertId: alert.id },
      })

      // ADR-6.2-10: the notification's template context includes the new monitoring_alerts.id
      // so the delivered alert can render/link `.../alerts/:alertId` directly.
      return createOrgAdminNotificationEntries({
        orgId,
        tx,
        template: {
          templateId: alertFired,
          severity,
          payload: { ...endpointAlertContext(updatedRow), monitoringAlertId: alert.id },
        },
      })
    })
  } catch (error) {
    if (logger) {
      operationalLog(
        logger,
        'error',
        OperationalEvent.MONITORING_HEALTH_CHECK_ROW_FAILED,
        'health-check row failed',
        { orgId, serviceEndpointId: endpoint.id, err: serializeLogError(error) }
      )
    }
    return []
  }
}

/**
 * AC 8, ADR-6.2-09: a single global tick — a non-blocking advisory lock guarantees at most one
 * tick runs at a time; per-org RLS-scoped due-query + bounded concurrency within each org.
 *
 * Correction to this story's original draft (which specified a plain session-level
 * `pg_advisory_lock`/`pg_advisory_unlock` pair "released in a finally"): `getDb()` is backed by
 * a pooled `postgres` client, so two separate `.execute()` calls are not guaranteed to run on
 * the same underlying connection — a session-level lock acquired on one pooled connection can't
 * be reliably released by an `pg_advisory_unlock` that happens to land on a different one (and,
 * worse, a concurrent tick could acquire its own session-scoped lock on ITS OWN pooled
 * connection, defeating the "at most one tick" guarantee entirely). `pg_try_advisory_xact_lock`
 * wrapped in a single outer transaction spanning the whole tick sidesteps this: the lock and its
 * (automatic) release are pinned to the one connection a `db.transaction()` call reserves for
 * its duration, and the lock is released the moment that transaction ends — commit, rollback, or
 * an uncaught error — with no manual unlock/connection-pinning required.
 */
export async function runHealthCheckTick(boss: BossService, logger?: WorkerLogger): Promise<void> {
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
          OperationalEvent.MONITORING_HEALTH_CHECK_TICK_SKIPPED_OVERLAP,
          'health-check tick skipped — previous tick still running',
          {}
        )
      }
      return
    }

    const dispatcher = createSsrfSafeDispatcher()
    const orgIds = await fetchAllOrgIds()
    const allJobs: NotificationQueueJob[] = []

    for (const orgId of orgIds) {
      let dueEndpoints: ServiceEndpointRow[]
      try {
        dueEndpoints = await fetchDueServiceEndpoints(orgId)
      } catch (error) {
        if (logger) {
          operationalLog(
            logger,
            'error',
            OperationalEvent.MONITORING_HEALTH_CHECK_ROW_FAILED,
            'health-check due-query failed for org',
            { orgId, err: serializeLogError(error) }
          )
        }
        continue
      }

      const jobsForOrg: NotificationQueueJob[] = []
      await runWithConcurrencyLimit(
        dueEndpoints,
        env.HEALTH_CHECK_MAX_CONCURRENCY,
        async (endpoint) => {
          const jobs = await processDueEndpoint(orgId, endpoint, dispatcher, logger)
          jobsForOrg.push(...jobs)
        }
      )
      allJobs.push(...jobsForOrg)
    }

    await sendNotificationJobs(boss, allJobs)
  })
}

export async function healthCheckTickHandler(
  boss: BossService,
  logger?: WorkerLogger
): Promise<void> {
  try {
    await runHealthCheckTick(boss, logger)
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ eventType: 'job.failed', job: JOB_NAME, error: error instanceof Error ? error.message : String(error) })}\n`
    )
    throw error
  }
}
