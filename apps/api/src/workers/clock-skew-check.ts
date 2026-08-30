import { sql } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import { OperationalEvent } from '@project-vault/shared'
import { getDb } from '@project-vault/db'
import { env } from '../config/env.js'
import { operationalLog, serializeLogError } from '../lib/logger.js'

export type ClockSkewStatus = 'ok' | 'warn' | 'unknown'

export type ClockSkewDiagnostics = {
  lastMeasuredMs: number | null
  measuredAt: string | null
  warnThresholdMs: number
  status: ClockSkewStatus
}

type WorkerLogger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>

function initialDiagnostics(): ClockSkewDiagnostics {
  return {
    lastMeasuredMs: null,
    measuredAt: null,
    warnThresholdMs: env.VAULT_HANDOFF_CLOCK_SKEW_WARN_MS,
    status: 'unknown',
  }
}

let diagnostics: ClockSkewDiagnostics = initialDiagnostics()

// Code-review finding (Edge Case Hunter, high): the boot one-shot and the 5-minute cron share the
// same job name and can overlap (e.g. a slow boot-time DB round-trip completing after a
// later-started but faster cron tick, or a vault reseal/unseal re-enqueueing the boot one-shot
// mid-interval). Without an ordering guard, a slower/older measurement can complete last and
// silently overwrite a newer one. Track the `requestStart` of the measurement currently reflected
// in `diagnostics` and only accept a new result if it started at or after that point, so the
// invocation with the most recent start time always wins regardless of completion order.
let lastAcceptedMeasurementStartMs: number | null = null

/**
 * Story 30.1 AC3/AC9: the current admin-diagnostics-facing clock-skew snapshot, extended onto
 * `GET /api/v1/admin/extensions/status` (following the `nativeLoginPolicy.state` diagnostics
 * precedent). Stays `'unknown'` until the first successful measurement; a failed check (AC10)
 * intentionally leaves the previous snapshot in place rather than resetting it to a false 'ok'.
 */
export function getClockSkewDiagnostics(): ClockSkewDiagnostics {
  return diagnostics
}

/** Test-only reset — mirrors the `__reset*ForTests` convention used by native-login-policy.ts. */
export function __resetClockSkewDiagnosticsForTests(): void {
  diagnostics = initialDiagnostics()
  lastAcceptedMeasurementStartMs = null
}

function toEpochMs(value: unknown): number | null {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}

type Measurement = {
  driftMs: number
  status: ClockSkewStatus
}

// Split out of runClockSkewCheck to keep it under the repo's eslint cyclomatic-complexity /
// cognitive-complexity thresholds. Code-review finding (Edge Case Hunter, high): returns true when
// this measurement should be discarded because a later-started measurement has already been
// accepted (the lost-update race described above `lastAcceptedMeasurementStartMs`).
function isStaleMeasurement(requestStart: number): boolean {
  return lastAcceptedMeasurementStartMs !== null && requestStart < lastAcceptedMeasurementStartMs
}

function logMeasurement(
  logger: WorkerLogger | undefined,
  { driftMs, status }: Measurement,
  message: string
): void {
  if (!logger) return
  operationalLog(
    logger,
    status === 'warn' ? 'warn' : 'info',
    OperationalEvent.CLOCK_SKEW_MEASURED,
    message,
    {
      driftMs,
      warnThresholdMs: env.VAULT_HANDOFF_CLOCK_SKEW_WARN_MS,
      status,
    }
  )
}

/**
 * Story 30.1 AC8/AC9/AC10/AC11 (W2 mitigation): compares this process's local clock against the
 * connected Postgres server's clock via a single `SELECT now()` round-trip — Postgres is already
 * the trusted, always-present reference clock in this architecture, so this introduces no new
 * external dependency (e.g. NTP). Never throws: a failed round-trip (DB unreachable, pool
 * exhausted) is logged as `CLOCK_SKEW_CHECK_FAILED` at `warn` and this cycle's measurement is
 * skipped, leaving the previous diagnostics snapshot untouched — a drifting/unreachable clock
 * must never crash a running instance or block startup (this is a diagnostic signal, not a
 * startup gate; see the claim contract's AC 15/AC 16 interlock). Safe to run concurrently with
 * itself (a single Node.js event loop) and safe across multiple replicas of the same instance,
 * each measuring its own local drift independently against the same Postgres primary — no
 * coordination or locking is required (AC11). Two overlapping invocations within one process
 * (e.g. the boot one-shot racing the first cron tick) are ordered by `requestStart`, not
 * completion time — see `lastAcceptedMeasurementStartMs` above, which prevents a slower/older
 * measurement from overwriting a newer one that already completed.
 */
export async function runClockSkewCheck(logger?: WorkerLogger): Promise<void> {
  const requestStart = Date.now()
  try {
    const rows = await getDb().execute<{ now: unknown }>(sql`SELECT now()`)
    const requestEnd = Date.now()
    const dbNowMs = toEpochMs(rows[0]?.now)
    if (dbNowMs === null) {
      throw new Error('SELECT now() returned an unparseable value')
    }
    // Code-review finding (Edge Case Hunter, medium): if the local clock steps backward between
    // the two Date.now() calls (NTP correction, VM clock adjustment), requestEnd - requestStart
    // can go negative, producing a negative round-trip estimate that would otherwise flow
    // unflagged into Math.abs(...) below and mask genuine local-clock instability as ordinary
    // skew. Clamp to zero — a negative round-trip is never a real network latency measurement.
    const roundTripEstimate = Math.max(0, (requestEnd - requestStart) / 2)
    const driftMs = Math.round(Math.abs(requestEnd - dbNowMs - roundTripEstimate))
    const status: ClockSkewStatus = driftMs >= env.VAULT_HANDOFF_CLOCK_SKEW_WARN_MS ? 'warn' : 'ok'
    const measurement: Measurement = { driftMs, status }

    if (isStaleMeasurement(requestStart)) {
      // A measurement that started later than this one has already been accepted — this
      // invocation is a straggler (see the lost-update race comment above
      // `lastAcceptedMeasurementStartMs`). Still log the raw measurement for observability, but
      // don't let it overwrite the newer snapshot.
      logMeasurement(
        logger,
        measurement,
        'clock skew measured (stale measurement, superseded diagnostics snapshot not updated)'
      )
      return
    }
    lastAcceptedMeasurementStartMs = requestStart

    diagnostics = {
      lastMeasuredMs: driftMs,
      measuredAt: new Date().toISOString(),
      warnThresholdMs: env.VAULT_HANDOFF_CLOCK_SKEW_WARN_MS,
      status,
    }

    logMeasurement(
      logger,
      measurement,
      status === 'warn'
        ? 'clock skew meets or exceeds the configured warning threshold'
        : 'clock skew measured'
    )
  } catch (err) {
    if (logger) {
      operationalLog(
        logger,
        'warn',
        OperationalEvent.CLOCK_SKEW_CHECK_FAILED,
        'clock-skew check failed; skipping this measurement cycle',
        { err: serializeLogError(err) }
      )
    }
  }
}
