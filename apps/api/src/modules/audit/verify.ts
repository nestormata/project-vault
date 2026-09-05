import { timingSafeEqual } from 'node:crypto'
import { and, asc, desc, eq, gte, lt, sql } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import { auditLogEntries } from '@project-vault/db/schema'
import { AuditEvent } from '@project-vault/shared'
import { getAuditKey, VaultSealedError } from '../vault/key-service.js'
import { currentAuditKeyVersion } from './key-version.js'
import { computeAuditHmac, GENESIS_SENTINEL } from './write-entry.js'

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

/** Story 1.25 AC-3: the "why" a row failed — previously these types carried no failure reason
 * at all. `hmac_mismatch` and `key_version_mismatch` are the two pre-existing failure modes,
 * unchanged in meaning; `chain_break` is new (a missing/wrong previous-row link that the
 * attested-gap mechanism could not explain as a legitimate retention purge). */
export type VerifyFailureReason = 'hmac_mismatch' | 'key_version_mismatch' | 'chain_break'

export type VerifyFailedEntry = {
  id: string
  eventType: string
  timestamp: string
  reason: VerifyFailureReason
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
type AuditVerifyRow = {
  id: string
  orgId: string
  actorTokenId: string | null
  actorType: string
  eventType: string
  resourceId: string | null
  resourceType: string | null
  payload: unknown
  keyVersion: number
  hmac: string
  createdAt: Date
  chainSeq: number
  previousEntryHmac: string | null
}

/** Story 1.25 AC-3: evaluates a single row's three independent failure checks (hmac, key
 * version, chain link) — extracted from `verifyAuditRange`'s loop to keep that function's own
 * cyclomatic/cognitive complexity within this repo's lint limits. Returns the failure reason (or
 * `null` for a passing row) and this row's own hmac, which becomes the next row's
 * `expectedPreviousHmac` regardless of whether this row passed. */
async function evaluateAuditRow(
  tx: Tx,
  row: AuditVerifyRow,
  auditKey: Buffer,
  currentKeyVersion: number,
  expectedPreviousHmac: string | null
): Promise<{ reason: VerifyFailureReason | null; hmac: string }> {
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
      // Story 1.25 AC-2: reproduces exactly what the write path fed into the digest — the row's
      // own stored previousEntryHmac, or the GENESIS sentinel when that column is null.
      previousEntryHmac: row.previousEntryHmac ?? GENESIS_SENTINEL,
    },
    auditKey
  )

  const hmacOk = hmacMatches(row.hmac, recomputed)
  const keyVersionOk = row.keyVersion === currentKeyVersion

  // Story 1.25 AC-3: the chain-link check, independent of the two checks above. A match means
  // either "true genesis, both sides null" or "this row's stored previous_entry_hmac equals the
  // actual previous row's hmac" (case 1 from the look-back fetch, or an ordinary interior link
  // between two rows that are both present in the fetched set). A mismatch is resolved via the
  // attested-gap lookup (AC-4) before being treated as tampering — this covers cases 2 and 3 from
  // the look-back fetch AND any interior gap (a row's actual predecessor missing from the DB
  // entirely, deleted rows between two present rows in the fetched set).
  let chainOk = row.previousEntryHmac === expectedPreviousHmac
  if (!chainOk && row.previousEntryHmac !== null) {
    chainOk = await hasAttestedGap(tx, row.orgId, row.previousEntryHmac)
  }

  let reason: VerifyFailureReason | null = null
  if (!hmacOk) reason = 'hmac_mismatch'
  else if (!keyVersionOk) reason = 'key_version_mismatch'
  else if (!chainOk) reason = 'chain_break'

  return { reason, hmac: row.hmac }
}

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
  // Story 1.25 AC-3: ordered by chain_seq (true insertion order), not createdAt — and now also
  // selects chainSeq/previousEntryHmac for the chain-walk below.
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
      chainSeq: auditLogEntries.chainSeq,
      previousEntryHmac: auditLogEntries.previousEntryHmac,
    })
    .from(auditLogEntries)
    .where(and(gte(auditLogEntries.createdAt, fromDate), lt(auditLogEntries.createdAt, toDate)))
    .orderBy(asc(auditLogEntries.chainSeq))
    .limit(AUDIT_VERIFY_MAX_ROWS + 1)

  if (rows.length > AUDIT_VERIFY_MAX_ROWS) {
    throw new RangeTooLargeError(
      `Range exceeds ${AUDIT_VERIFY_MAX_ROWS} rows; narrow the from/to window and call again`
    )
  }

  const currentKeyVersion = await currentAuditKeyVersion(tx)

  // Story 1.25 AC-3 range-boundary handling: the range fetch is [from, to) on created_at, not on
  // chain_seq, so the window's first row is not necessarily the chain's genesis row. Fetch the
  // ACTUAL immediate predecessor (which may be outside [from, to)) to seed expectedPreviousHmac
  // before validating any fetched row's chain link — otherwise every ranged verify call would
  // falsely flag its own first row as a chain break.
  let expectedPreviousHmac: string | null = null
  if (rows.length > 0) {
    const firstRow = rows[0]
    if (firstRow) {
      const [predecessor] = await tx
        .select({ hmac: auditLogEntries.hmac })
        .from(auditLogEntries)
        .where(
          and(
            eq(auditLogEntries.orgId, firstRow.orgId),
            lt(auditLogEntries.chainSeq, firstRow.chainSeq)
          )
        )
        .orderBy(desc(auditLogEntries.chainSeq))
        .limit(1)
      expectedPreviousHmac = predecessor?.hmac ?? null
    }
  }

  const failed: VerifyFailedEntry[] = []
  let passed = 0
  let failedCount = 0

  for (const row of rows) {
    const { reason } = await evaluateAuditRow(
      tx,
      row,
      auditKey,
      currentKeyVersion,
      expectedPreviousHmac
    )

    if (reason === null) {
      passed += 1
    } else {
      failedCount += 1
      if (failed.length < FAILED_ENTRIES_CAP) {
        failed.push({
          id: row.id,
          eventType: row.eventType,
          timestamp: row.createdAt.toISOString(),
          reason,
        })
      }
    }

    // The next row's expected predecessor is always THIS row's actual hmac — regardless of
    // whether this row itself passed or failed verification (a subsequent legitimate write
    // would have chained onto this row's real hmac either way).
    expectedPreviousHmac = row.hmac
  }

  return finalizeVerifyResult({ rowsChecked: rows.length, passed, failed, failedCount })
}

/** Story 1.25 AC-4: consulted only when a row's stored `previous_entry_hmac` cannot be matched to
 * any row actually present in the table (case 3 from the look-back fetch, or an interior gap
 * where deleted rows once existed between two present rows). A match means a retention-purge
 * worker (`audit-retention-prune.ts`) already recorded this exact orphaned hash as an expected,
 * attested consequence of a legitimate purge — not tampering. */
async function hasAttestedGap(tx: Tx, orgId: string, orphanedHash: string): Promise<boolean> {
  const rows = await tx.execute<{ found: number }>(sql`
    SELECT 1 AS found
      FROM audit_log_entries
     WHERE org_id = ${orgId}
       AND event_type = ${AuditEvent.RETENTION_PURGE_BOUNDARY}
       AND payload ->> 'attestedGapHash' = ${orphanedHash}
     LIMIT 1
  `)
  return rows.length > 0
}
