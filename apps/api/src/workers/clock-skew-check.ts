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
}

function toEpochMs(value: unknown): number | null {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
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
 * itself (a single Node.js event loop; the module-level `diagnostics` variable is only ever
 * reassigned, never mutated in place) and safe across multiple replicas of the same instance,
 * each measuring its own local drift independently against the same Postgres primary — no
 * coordination or locking is required (AC11).
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
    const roundTripEstimate = (requestEnd - requestStart) / 2
    const driftMs = Math.round(Math.abs(requestEnd - dbNowMs - roundTripEstimate))
    const status: ClockSkewStatus = driftMs >= env.VAULT_HANDOFF_CLOCK_SKEW_WARN_MS ? 'warn' : 'ok'

    diagnostics = {
      lastMeasuredMs: driftMs,
      measuredAt: new Date().toISOString(),
      warnThresholdMs: env.VAULT_HANDOFF_CLOCK_SKEW_WARN_MS,
      status,
    }

    if (logger) {
      operationalLog(
        logger,
        status === 'warn' ? 'warn' : 'info',
        OperationalEvent.CLOCK_SKEW_MEASURED,
        status === 'warn'
          ? 'clock skew meets or exceeds the configured warning threshold'
          : 'clock skew measured',
        { driftMs, warnThresholdMs: env.VAULT_HANDOFF_CLOCK_SKEW_WARN_MS, status }
      )
    }
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
