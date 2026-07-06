import { timingSafeEqual } from 'node:crypto'
import { and, asc, gte, lt } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import { auditLogEntries } from '@project-vault/db/schema'
import { getAuditKey } from '../vault/key-service.js'
import { currentAuditKeyVersion } from './key-version.js'
import { computeAuditHmac } from './write-entry.js'

/** D4 — no stated bound in epics.md; this story adds one to prevent an unbounded, CPU-bound
 * per-row HMAC recompute from being a self-inflicted availability risk. */
export const AUDIT_VERIFY_MAX_RANGE_DAYS = 90
export const AUDIT_VERIFY_MAX_ROWS = 50_000

/** AC-2 — the `failed` array itself is otherwise unbounded on a bulk-tamper scenario; cap the
 * payload while still reporting the true `failedCount` in `summary` and the response shape. */
const FAILED_ENTRIES_CAP = 500

const MS_PER_DAY = 24 * 60 * 60 * 1000

export class InvalidRangeError extends Error {}
export class RangeTooLargeError extends Error {}

export type VerifyFailedEntry = {
  id: string
  eventType: string
  timestamp: string
}

export type VerifyResult = {
  summary: string
  rowsChecked: number
  passed: number
  failed: VerifyFailedEntry[]
  failedCount: number
  failedTruncated: boolean
  verifiedAt: string
}

/** AC-8 — a complete, grammatically correct, jargon-free English sentence. Uses the true
 * `failedCount`, not `failed.length`, so the summary is never misleading even when the
 * `failed` array itself has been truncated (AC-2). */
export function buildVerifySummary(
  rowsChecked: number,
  passed: number,
  failedCount: number
): string {
  if (rowsChecked === 0) return 'No records found in this range'
  if (failedCount === 0) return `All ${rowsChecked} records verified — no tampering detected`
  return `${passed} of ${rowsChecked} records verified — ${failedCount} record${
    failedCount === 1 ? '' : 's'
  } failed integrity check`
}

/** AC-1 — constant-time comparison of two same-length HMAC hex strings. A length mismatch
 * (which should never happen given computeAuditHmac's fixed SHA-256 output size, but guarded
 * defensively) is treated as a failed match rather than thrown. */
function hmacMatches(stored: string, recomputed: string): boolean {
  const storedBuffer = Buffer.from(stored, 'hex')
  const recomputedBuffer = Buffer.from(recomputed, 'hex')
  if (storedBuffer.length !== recomputedBuffer.length) return false
  if (storedBuffer.length === 0) return false
  return timingSafeEqual(storedBuffer, recomputedBuffer)
}

export type VerifyAuditRangeInput = {
  orgId: string
  from: string
  to: string
}

/**
 * Recomputes the HMAC for every `audit_log_entries` row in `[from, to)` (half-open, D4) for the
 * caller's org and reports a pass/fail summary. Relies entirely on RLS (already set on `tx` by
 * SecureRoute's `setRlsOrgContext`, AC-5) for tenant isolation — no `WHERE org_id = ...` clause
 * is added here.
 *
 * Does not catch `getAuditKey()` throwing (vault sealed) — that error is left to propagate to
 * the route handler, which maps it to `503 audit_key_unavailable` (AC-10, Task 1.2).
 */
export async function verifyAuditRange(
  tx: Tx,
  input: VerifyAuditRangeInput
): Promise<VerifyResult> {
  const fromDate = new Date(input.from)
  const toDate = new Date(input.to)

  if (toDate.getTime() < fromDate.getTime()) {
    throw new InvalidRangeError('to must not be before from')
  }

  const spanMs = toDate.getTime() - fromDate.getTime()
  if (spanMs > AUDIT_VERIFY_MAX_RANGE_DAYS * MS_PER_DAY) {
    throw new RangeTooLargeError(
      `Range exceeds ${AUDIT_VERIFY_MAX_RANGE_DAYS} days; narrow the from/to window and call again`
    )
  }

  // Vault-sealed check happens before the row fetch — a sealed vault means no recompute can
  // ever succeed, so there is no reason to touch the database first (AC-10, Task 1.2).
  const auditKey = getAuditKey()

  // D4 — single bounded query (LIMIT + 1), not a separate COUNT(*) pre-check: race-free against
  // concurrent writes (AC-12) and strictly cheaper than a redundant COUNT on the hot path.
  const rows = await tx
    .select({
      id: auditLogEntries.id,
      orgId: auditLogEntries.orgId,
      actorTokenId: auditLogEntries.actorTokenId,
      actorType: auditLogEntries.actorType,
      eventType: auditLogEntries.eventType,
      resourceId: auditLogEntries.resourceId,
      resourceType: auditLogEntries.resourceType,
      payload: auditLogEntries.payload,
      keyVersion: auditLogEntries.keyVersion,
      hmac: auditLogEntries.hmac,
      createdAt: auditLogEntries.createdAt,
    })
    .from(auditLogEntries)
    .where(and(gte(auditLogEntries.createdAt, fromDate), lt(auditLogEntries.createdAt, toDate)))
    .orderBy(asc(auditLogEntries.createdAt))
    .limit(AUDIT_VERIFY_MAX_ROWS + 1)

  if (rows.length > AUDIT_VERIFY_MAX_ROWS) {
    throw new RangeTooLargeError(
      `Range exceeds ${AUDIT_VERIFY_MAX_ROWS} rows; narrow the from/to window and call again`
    )
  }

  const currentKeyVersion = await currentAuditKeyVersion(tx)

  const failed: VerifyFailedEntry[] = []
  let passed = 0
  let failedCount = 0

  for (const row of rows) {
    // The write path (human-entry.ts/defaultAuditWriter) omits resourceId/resourceType from the
    // canonical-JSON HMAC input entirely when the caller didn't set them (via an `undefined`
    // field), rather than storing/hashing an explicit `null`. Reading them back from Postgres
    // always yields `null` for an unset nullable column, so they must be converted back to
    // `undefined` here or every row without a resource would recompute to a different HMAC than
    // the one written — a false "tampered" result on the majority of ordinary audit rows.
    const recomputed = computeAuditHmac(
      {
        orgId: row.orgId,
        actorTokenId: row.actorTokenId,
        actorType: row.actorType,
        eventType: row.eventType,
        resourceId: row.resourceId ?? undefined,
        resourceType: row.resourceType ?? undefined,
        payload: row.payload,
        keyVersion: row.keyVersion,
      },
      auditKey
    )

    // AC-3 — both conditions are checked independently; a row can fail on either alone.
    const isValid = hmacMatches(row.hmac, recomputed) && row.keyVersion === currentKeyVersion

    if (isValid) {
      passed += 1
    } else {
      failedCount += 1
      if (failed.length < FAILED_ENTRIES_CAP) {
        failed.push({
          id: row.id,
          eventType: row.eventType,
          timestamp: row.createdAt.toISOString(),
        })
      }
    }
  }

  const rowsChecked = rows.length

  return {
    summary: buildVerifySummary(rowsChecked, passed, failedCount),
    rowsChecked,
    passed,
    failed,
    failedCount,
    failedTruncated: failedCount > failed.length,
    verifiedAt: new Date().toISOString(),
  }
}
