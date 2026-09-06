import { and, asc, desc, gte, lt, sql } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import { platformAuditEvents } from '@project-vault/db/schema'
import { PlatformAuditAction } from '@project-vault/shared'
import { getPlatformAuditKey } from '../vault/key-service.js'
import { currentPlatformAuditKeyVersion } from './key-version.js'
import { computePlatformAuditHmac } from './write-entry.js'
import { GENESIS_SENTINEL } from '../audit/write-entry.js'
// Reused, not duplicated (D11) — generic range-validation errors, HMAC comparison, and summary-
// sentence logic have no org-scoped coupling, so this story's platform-scoped verify imports them
// directly rather than reimplementing byte-for-byte identical logic.
import {
  finalizeVerifyResult,
  hmacMatches,
  RangeTooLargeError,
  validateVerifyRange,
  type VerifyFailureReason,
} from '../audit/verify.js'

export {
  InvalidRangeError,
  RangeTooLargeError,
  rangeErrorResponse,
  verifyRouteErrorResponse,
} from '../audit/verify.js'
export { buildVerifySummary as buildPlatformAuditVerifySummary } from '../audit/verify.js'
export type { VerifyFailureReason } from '../audit/verify.js'

/** D11: same numeric bounds Story 8.1 established for the org-scoped verify endpoint, own named
 * constants (this table's write volume is expected to be far lower, but there is no reason to
 * pick different numbers without operational evidence). */
export const PLATFORM_AUDIT_VERIFY_MAX_RANGE_DAYS = 90
export const PLATFORM_AUDIT_VERIFY_MAX_ROWS = 50_000
export const PLATFORM_AUDIT_VERIFY_FAILED_ENTRIES_CAP = 500

export type PlatformAuditVerifyFailedEntry = {
  id: string
  actionType: string
  timestamp: string
  reason: VerifyFailureReason
}

export type PlatformAuditVerifyResult = {
  summary: string
  rowsChecked: number
  passed: number
  failed: PlatformAuditVerifyFailedEntry[]
  failedCount: number
  failedTruncated: boolean
  verifiedAt: string
}

export type VerifyPlatformAuditRangeInput = {
  from: string
  to: string
}

/** Story 1.25 AC-4: platform-wide equivalent of the org-scoped hasAttestedGap — no org filter
 * (this table has none), same lookup shape otherwise. */
async function hasAttestedGap(tx: Tx, orphanedHash: string): Promise<boolean> {
  const rows = await tx.execute<{ found: number }>(sql`
    SELECT 1 AS found
      FROM platform_audit_events
     WHERE action_type = ${PlatformAuditAction.RETENTION_PURGE_BOUNDARY}
       AND payload ->> 'attestedGapHash' = ${orphanedHash}
     LIMIT 1
  `)
  return rows.length > 0
}

/**
 * Story 9.4 AC-11/D11: recomputes the HMAC for every `platform_audit_events` row in `[from, to)`
 * (half-open) PLATFORM-WIDE — unlike the org-scoped verify, there is no tenant scope to filter by
 * (D11): this endpoint verifies every row regardless of `target_org_id`, which is correct since
 * there is exactly one platform-operator "tenant". Assumes the caller has already set
 * `app.platform_operator_verified` on `tx` (mirrors 8.1's `verifyAuditRange` relying on the
 * caller's RLS context) — does not set it itself.
 *
 * Does not catch `getPlatformAuditKey()` throwing (vault sealed) — checked BEFORE any row fetch
 * (mirrors 8.1's ordering exactly), left to propagate to the route handler, which maps it to
 * `503 platform_audit_key_unavailable`.
 *
 * Story 1.25 AC-3: walks the chain in `chain_seq` order (single global chain, D11) with the same
 * look-back-seed / attested-gap-lookup design as the org-scoped verify — see that module's
 * `verifyAuditRange` for the fully commented algorithm; this is its platform-wide counterpart.
 */
type PlatformAuditVerifyRow = {
  id: string
  operatorId: string
  actionType: string
  targetOrgId: string | null
  targetUserId: string | null
  payload: unknown
  keyVersion: number
  hmac: string
  createdAt: Date
  chainSeq: number
  previousEntryHmac: string | null
}

/** Story 1.25 AC-3: evaluates a single row's three independent failure checks — extracted from
 * `verifyPlatformAuditRange`'s loop to keep that function's own cyclomatic/cognitive complexity
 * within this repo's lint limits. Same shape as the org-scoped `evaluateAuditRow` (no org
 * filtering here — a single global chain, D11). */
async function evaluatePlatformAuditRow(
  tx: Tx,
  row: PlatformAuditVerifyRow,
  platformAuditKey: Buffer,
  currentKeyVersion: number,
  expectedPreviousHmac: string | null
): Promise<{ reason: VerifyFailureReason | null }> {
  // Same gotcha as the org-scoped precedent: targetOrgId/targetUserId must round-trip through
  // `undefined` (not Postgres `null`) to match what the write path fed into the HMAC input.
  const recomputed = computePlatformAuditHmac(
    {
      operatorId: row.operatorId,
      actionType: row.actionType,
      targetOrgId: row.targetOrgId ?? undefined,
      targetUserId: row.targetUserId ?? undefined,
      payload: row.payload,
      keyVersion: row.keyVersion,
      previousEntryHmac: row.previousEntryHmac ?? GENESIS_SENTINEL,
    },
    platformAuditKey
  )

  const hmacOk = hmacMatches(row.hmac, recomputed)
  const keyVersionOk = row.keyVersion === currentKeyVersion

  let chainOk = row.previousEntryHmac === expectedPreviousHmac
  if (!chainOk && row.previousEntryHmac !== null) {
    chainOk = await hasAttestedGap(tx, row.previousEntryHmac)
  }

  let reason: VerifyFailureReason | null = null
  if (!hmacOk) reason = 'hmac_mismatch'
  else if (!keyVersionOk) reason = 'key_version_mismatch'
  else if (!chainOk) reason = 'chain_break'

  return { reason }
}

export async function verifyPlatformAuditRange(
  tx: Tx,
  input: VerifyPlatformAuditRangeInput
): Promise<PlatformAuditVerifyResult> {
  const { fromDate, toDate } = validateVerifyRange(
    input.from,
    input.to,
    PLATFORM_AUDIT_VERIFY_MAX_RANGE_DAYS
  )

  const platformAuditKey = getPlatformAuditKey()

  const rows = await tx
    .select({
      id: platformAuditEvents.id,
      operatorId: platformAuditEvents.operatorId,
      actionType: platformAuditEvents.actionType,
      targetOrgId: platformAuditEvents.targetOrgId,
      targetUserId: platformAuditEvents.targetUserId,
      payload: platformAuditEvents.payload,
      keyVersion: platformAuditEvents.keyVersion,
      hmac: platformAuditEvents.hmac,
      createdAt: platformAuditEvents.createdAt,
      chainSeq: platformAuditEvents.chainSeq,
      previousEntryHmac: platformAuditEvents.previousEntryHmac,
    })
    .from(platformAuditEvents)
    .where(
      and(gte(platformAuditEvents.createdAt, fromDate), lt(platformAuditEvents.createdAt, toDate))
    )
    .orderBy(asc(platformAuditEvents.chainSeq))
    .limit(PLATFORM_AUDIT_VERIFY_MAX_ROWS + 1)

  if (rows.length > PLATFORM_AUDIT_VERIFY_MAX_ROWS) {
    throw new RangeTooLargeError(
      `Range exceeds ${PLATFORM_AUDIT_VERIFY_MAX_ROWS} rows; narrow the from/to window and call again`
    )
  }

  const currentKeyVersion = await currentPlatformAuditKeyVersion(tx)

  let expectedPreviousHmac: string | null = null
  if (rows.length > 0) {
    const firstRow = rows[0]
    if (firstRow) {
      const [predecessor] = await tx
        .select({ hmac: platformAuditEvents.hmac })
        .from(platformAuditEvents)
        .where(lt(platformAuditEvents.chainSeq, firstRow.chainSeq))
        .orderBy(desc(platformAuditEvents.chainSeq))
        .limit(1)
      expectedPreviousHmac = predecessor?.hmac ?? null
    }
  }

  const failed: PlatformAuditVerifyFailedEntry[] = []
  let passed = 0
  let failedCount = 0

  for (const row of rows) {
    const { reason } = await evaluatePlatformAuditRow(
      tx,
      row,
      platformAuditKey,
      currentKeyVersion,
      expectedPreviousHmac
    )

    if (reason === null) {
      passed += 1
    } else {
      failedCount += 1
      if (failed.length < PLATFORM_AUDIT_VERIFY_FAILED_ENTRIES_CAP) {
        failed.push({
          id: row.id,
          actionType: row.actionType,
          timestamp: row.createdAt.toISOString(),
          reason,
        })
      }
    }

    expectedPreviousHmac = row.hmac
  }

  return finalizeVerifyResult({ rowsChecked: rows.length, passed, failed, failedCount })
}
