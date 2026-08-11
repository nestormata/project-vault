import { statfs } from 'node:fs/promises'
import { OperationalEvent } from '@project-vault/shared'
import type { FastifyBaseLogger } from 'fastify'
import { env } from '../../config/env.js'
import { operationalLog } from '../../lib/logger.js'
import { getVaultStatus } from '../vault/key-service.js'

// AC-3: per-check timeout — short enough that a single slow dependency can never make the
// aggregate endpoint hang, isolated per-check so one timeout never throws the whole request.
const DB_CHECK_TIMEOUT_MS = 2000
const DISK_CHECK_TIMEOUT_MS = 2000
// AC-3: hard total budget across every check combined.
export const STATUS_TOTAL_BUDGET_MS = 5000

export type CheckOutcome = 'ok' | 'degraded' | 'unavailable' | 'skipped'

export type CheckResult = {
  status: CheckOutcome
  // AC-7: stable, documented reason codes only — never a raw error message, stack trace, or
  // filesystem path.
  reason?: string
}

export type DbPool = {
  query: (sql: string) => Promise<unknown>
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve(onTimeout())
    }, ms)
    promise.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(onTimeout())
      }
    )
  })
}

/** AC-1/AC-3: minimal `SELECT 1` through the same connection context /ready already uses,
 * bounded by a short timeout so a hung DB never hangs the aggregate response. */
export async function checkDatabase(
  dbPool: DbPool | undefined,
  logger: FastifyBaseLogger
): Promise<CheckResult> {
  if (!dbPool) return { status: 'unavailable', reason: 'db_unavailable' }

  let timedOut = false
  const result = await withTimeout(
    dbPool
      .query('SELECT 1')
      .then((): CheckResult => ({ status: 'ok' }))
      .catch((err): CheckResult => {
        operationalLog(
          logger,
          'error',
          OperationalEvent.STATUS_CHECK_ERROR,
          'status db check failed',
          {
            check: 'database',
            errName: err instanceof Error ? err.name : undefined,
          }
        )
        return { status: 'unavailable', reason: 'db_error' }
      }),
    DB_CHECK_TIMEOUT_MS,
    (): CheckResult => {
      timedOut = true
      return { status: 'unavailable', reason: 'db_timeout' }
    }
  )
  if (timedOut) {
    operationalLog(
      logger,
      'warn',
      OperationalEvent.STATUS_CHECK_TIMEOUT,
      'status db check timed out',
      {
        check: 'database',
        timeoutMs: DB_CHECK_TIMEOUT_MS,
      }
    )
  }
  return result
}

/** AC-1/AC-3: vault state comes from existing in-memory state (no DB call, no I/O) — this check
 * can never time out or throw. */
export function checkVault(): CheckResult {
  const vaultStatus = getVaultStatus()
  if (vaultStatus === 'unsealed') return { status: 'ok' }
  if (vaultStatus === 'sealed') return { status: 'unavailable', reason: 'vault_sealed' }
  return { status: 'unavailable', reason: 'vault_uninitialized' }
}

/**
 * AC-1/AC-3: disk-capacity check — only meaningful when filesystem-backed backup storage is
 * configured (`BACKUP_STORAGE_PATH`). No such env var exists for S3-backed or unconfigured
 * backup destinations, so this check reports 'skipped' rather than failing the aggregate
 * response — it is optional/skippable by design, documented in Completion Notes.
 */
export async function checkDisk(logger: FastifyBaseLogger): Promise<CheckResult> {
  const path = env.BACKUP_STORAGE_PATH
  if (!path) return { status: 'skipped', reason: 'disk_not_configured' }

  let timedOut = false
  const result = await withTimeout(
    statfs(path)
      .then((stats): CheckResult => {
        const totalBytes = stats.blocks * stats.bsize
        const freeBytes = stats.bavail * stats.bsize
        if (totalBytes <= 0) return { status: 'unavailable', reason: 'disk_check_failed' }
        const freePercent = (freeBytes / totalBytes) * 100
        if (freePercent < env.STATUS_DISK_MIN_FREE_PERCENT) {
          return { status: 'unavailable', reason: 'disk_threshold_exceeded' }
        }
        return { status: 'ok' }
      })
      .catch((err): CheckResult => {
        operationalLog(
          logger,
          'error',
          OperationalEvent.STATUS_CHECK_ERROR,
          'status disk check failed',
          { check: 'disk', errName: err instanceof Error ? err.name : undefined }
        )
        return { status: 'unavailable', reason: 'disk_check_failed' }
      }),
    DISK_CHECK_TIMEOUT_MS,
    (): CheckResult => {
      timedOut = true
      return { status: 'unavailable', reason: 'disk_check_failed' }
    }
  )
  if (timedOut) {
    operationalLog(
      logger,
      'warn',
      OperationalEvent.STATUS_CHECK_TIMEOUT,
      'status disk check timed out',
      {
        check: 'disk',
        timeoutMs: DISK_CHECK_TIMEOUT_MS,
      }
    )
  }
  return result
}

export type AggregateStatus = 'healthy' | 'degraded' | 'unavailable'

export type StatusChecks = {
  database: CheckResult
  vault: CheckResult
  disk: CheckResult
}

/**
 * AC-1: overall status derivation. 'skipped' checks (disk, when unconfigured) never count
 * against the aggregate. Any 'unavailable' required check makes the whole response unavailable
 * (HTTP 503); this endpoint currently has no 'degraded'-only condition wired up (every required
 * check is binary ok/unavailable) but the type/contract supports one for future checks.
 */
export function deriveAggregateStatus(checks: StatusChecks): AggregateStatus {
  const required = [checks.database, checks.vault, checks.disk].filter(
    (c) => c.status !== 'skipped'
  )
  if (required.some((c) => c.status === 'unavailable')) return 'unavailable'
  if (required.some((c) => c.status === 'degraded')) return 'degraded'
  return 'healthy'
}

export async function runStatusChecks(
  dbPool: DbPool | undefined,
  logger: FastifyBaseLogger
): Promise<StatusChecks> {
  // AC-3: each check is isolated (its own try/catch inside, above) and run concurrently — total
  // wall time bounded by the slowest individual check's own timeout, well under
  // STATUS_TOTAL_BUDGET_MS.
  const [database, disk] = await Promise.all([checkDatabase(dbPool, logger), checkDisk(logger)])
  return { database, vault: checkVault(), disk }
}
