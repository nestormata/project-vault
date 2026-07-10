import { and, asc, gte, lt } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import { platformAuditEvents } from '@project-vault/db/schema'
import { getPlatformAuditKey } from '../vault/key-service.js'
import { currentPlatformAuditKeyVersion } from './key-version.js'
import { computePlatformAuditHmac } from './write-entry.js'
// Reused, not duplicated (D11) — generic range-validation errors, HMAC comparison, and summary-
// sentence logic have no org-scoped coupling, so this story's platform-scoped verify imports them
// directly rather than reimplementing byte-for-byte identical logic.
import {
  finalizeVerifyResult,
  hmacMatches,
  RangeTooLargeError,
  validateVerifyRange,
} from '../audit/verify.js'

export {
  InvalidRangeError,
  RangeTooLargeError,
  rangeErrorResponse,
  verifyRouteErrorResponse,
} from '../audit/verify.js'
export { buildVerifySummary as buildPlatformAuditVerifySummary } from '../audit/verify.js'

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
 */
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
    })
    .from(platformAuditEvents)
    .where(
      and(gte(platformAuditEvents.createdAt, fromDate), lt(platformAuditEvents.createdAt, toDate))
    )
    .orderBy(asc(platformAuditEvents.createdAt))
    .limit(PLATFORM_AUDIT_VERIFY_MAX_ROWS + 1)

  if (rows.length > PLATFORM_AUDIT_VERIFY_MAX_ROWS) {
    throw new RangeTooLargeError(
      `Range exceeds ${PLATFORM_AUDIT_VERIFY_MAX_ROWS} rows; narrow the from/to window and call again`
    )
  }

  const currentKeyVersion = await currentPlatformAuditKeyVersion(tx)

  const failed: PlatformAuditVerifyFailedEntry[] = []
  let passed = 0
  let failedCount = 0

  for (const row of rows) {
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
      },
      platformAuditKey
    )

    const isValid = hmacMatches(row.hmac, recomputed) && row.keyVersion === currentKeyVersion

    if (isValid) {
      passed += 1
    } else {
      failedCount += 1
      if (failed.length < PLATFORM_AUDIT_VERIFY_FAILED_ENTRIES_CAP) {
        failed.push({
          id: row.id,
          actionType: row.actionType,
          timestamp: row.createdAt.toISOString(),
        })
      }
    }
  }

  return finalizeVerifyResult({ rowsChecked: rows.length, passed, failed, failedCount })
}
