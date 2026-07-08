import { timingSafeEqual } from 'node:crypto'
import { and, asc, gte, lt } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import { auditLogEntries } from '@project-vault/db/schema'
import { getAuditKey, VaultSealedError } from '../vault/key-service.js'
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

/** Shared by every `/audit/verify`-shaped route handler (org-scoped here, and Story 9.4's
 * platform-scoped sibling) — maps the two range-validation errors above to their identical
 * `422` response shape. Returns `null` for any other error so the caller can fall through to its
 * own (route-specific) handling, e.g. a sealed-vault 503. */
export function rangeErrorResponse(
  error: unknown
): { status: 422; body: { code: string; message: string } } | null {
  if (error instanceof InvalidRangeError) {
    return { status: 422, body: { code: 'invalid_range', message: error.message } }
  }
  if (error instanceof RangeTooLargeError) {
    return { status: 422, body: { code: 'range_too_large', message: error.message } }
  }
  return null
}

/** Shared by every `/audit/verify`-shaped route handler's `catch` block: maps a range error to
 * its `422` response (via `rangeErrorResponse`) or a sealed-vault error to a `503` using the
 * caller's own error-code/message (org-scoped vs. platform-scoped use different literal
 * strings) — returns `null` for anything else so the caller re-throws. */
export function verifyRouteErrorResponse(
  error: unknown,
  vaultSealedBody: { code: string; message: string }
): { status: number; body: { code: string; message: string } } | null {
  const rangeResponse = rangeErrorResponse(error)
  if (rangeResponse) return rangeResponse
  if (error instanceof VaultSealedError) return { status: 503, body: vaultSealedBody }
  return null
}

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

/** Shared by both verify-range implementations (org-scoped here, platform-scoped in Story 9.4) —
 * validates `[from, to)` against the two range errors above using a caller-supplied max-days
 * bound, so each table can keep its own named constant while sharing the identical validation
 * logic. */
export function validateVerifyRange(
  from: string,
  to: string,
  maxRangeDays: number
): { fromDate: Date; toDate: Date } {
  const fromDate = new Date(from)
  const toDate = new Date(to)

  if (toDate.getTime() < fromDate.getTime()) {
    throw new InvalidRangeError('to must not be before from')
  }

  const spanMs = toDate.getTime() - fromDate.getTime()
  if (spanMs > maxRangeDays * MS_PER_DAY) {
    throw new RangeTooLargeError(
      `Range exceeds ${maxRangeDays} days; narrow the from/to window and call again`
    )
  }

  return { fromDate, toDate }
}

/** Shared by both verify-range implementations — assembles the final result object once the
 * per-row pass/fail loop has finished. Generic over the `failed` entry shape since the two tables
 * report a different discriminating field (`eventType` vs `actionType`). */
export function finalizeVerifyResult<TFailedEntry>(input: {
  rowsChecked: number
  passed: number
  failed: TFailedEntry[]
  failedCount: number
}): {
  summary: string
  rowsChecked: number
  passed: number
  failed: TFailedEntry[]
  failedCount: number
  failedTruncated: boolean
  verifiedAt: string
} {
  return {
    summary: buildVerifySummary(input.rowsChecked, input.passed, input.failedCount),
    rowsChecked: input.rowsChecked,
    passed: input.passed,
    failed: input.failed,
    failedCount: input.failedCount,
    failedTruncated: input.failedCount > input.failed.length,
    verifiedAt: new Date().toISOString(),
  }
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
 * defensively) is treated as a failed match rather than thrown. Exported so Story 9.4's
 * platform-audit verify equivalent can reuse it verbatim rather than duplicating it. */
export function hmacMatches(stored: string, recomputed: string): boolean {
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
  const { fromDate, toDate } = validateVerifyRange(
    input.from,
    input.to,
    AUDIT_VERIFY_MAX_RANGE_DAYS
  )

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

  return finalizeVerifyResult({ rowsChecked: rows.length, passed, failed, failedCount })
}
