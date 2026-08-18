import { sql } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import { auditStorageQuotaConfig } from '@project-vault/db/schema'
import { AuditEvent, PlatformAuditAction } from '@project-vault/shared'
import { env } from '../../config/env.js'
import {
  writePlatformAuditEntryOrFailClosed,
  writeSystemAuditEntryOrFailClosed,
} from '../../lib/audit-or-fail-closed.js'

/**
 * Story 22.1 AC-4 — the org's effective quota, OUTSIDE the enforcement path (this is for display
 * and for tests; the gate statement in quota-gate.ts resolves the same precedence internally, in
 * one round trip, and this function is not on that hot path). Precedence: the org's own
 * `audit_storage_quota_config.quota_bytes` if a row exists (including an explicit NULL, which
 * means unlimited FOR THAT ORG and overrides the env default); else the env default if > 0; else
 * unlimited. Returns `null` for "unlimited".
 */
export async function resolveEffectiveOrgQuotaBytes(
  tx: Pick<Tx, 'execute'>,
  orgId: string
): Promise<number | null> {
  const rows = await tx.execute<{ quota_bytes: string | null }>(sql`
    SELECT quota_bytes FROM audit_storage_quota_config WHERE org_id = ${orgId}
  `)
  if (rows.length > 0) {
    const value = rows[0]?.quota_bytes
    return value === null || value === undefined ? null : Number(value)
  }
  if (env.AUDIT_ORG_DEFAULT_STORAGE_QUOTA_MB > 0) {
    return env.AUDIT_ORG_DEFAULT_STORAGE_QUOTA_MB * 1024 * 1024
  }
  return null
}

/**
 * Story 22.2 AC-3 — the org's effective write-rate cap, OUTSIDE the enforcement path (display and
 * tests only; quota-gate.ts's runRateGateStatement() resolves the same precedence internally, in
 * one round trip). Precedence, mirroring AC-3's decision (the OPPOSITE of quotaBytes' NULL
 * semantics): the org's own `write_rate_per_minute` if a row exists AND it is non-NULL; else the
 * env default if `> 0`; else unlimited (`null`). An existing row with an explicit NULL is treated
 * exactly like "no row" — "no per-org override," not "unlimited for this org."
 */
export async function resolveEffectiveOrgWriteRatePerMinute(
  tx: Pick<Tx, 'execute'>,
  orgId: string
): Promise<number | null> {
  const rows = await tx.execute<{ write_rate_per_minute: string | null }>(sql`
    SELECT write_rate_per_minute FROM audit_storage_quota_config WHERE org_id = ${orgId}
  `)
  const value = rows[0]?.write_rate_per_minute
  if (value !== null && value !== undefined) {
    return Number(value)
  }
  if (env.AUDIT_ORG_DEFAULT_WRITE_RATE_PER_MIN > 0) {
    return env.AUDIT_ORG_DEFAULT_WRITE_RATE_PER_MIN
  }
  return null
}

export type SetOrgAuditQuotaInput = {
  orgId: string
  /** `null` clears the org's quota back to "no per-org override" (falls back to the env default,
   * or unlimited). `undefined` leaves the existing value unchanged. */
  quotaBytes?: number | null
  /** Story 22.2 AC-13 — same conventions as `quotaBytes`: `null` clears the per-org override
   * (falls back to the instance default), `undefined` leaves the existing value unchanged. Both
   * may be set in one call, since they live on the same row and an operator plausibly changes
   * both at once. */
  writeRatePerMinute?: number | null
  operatorId: string
  operatorIpAddress?: string | null
  /** Story 22.3 AC-4 — when the caller's overcommit check (`computeAuditQuotaAllocation()`)
   * fired and the operator explicitly proceeded anyway, both of these are recorded in the SAME
   * `audit.quota_configured` payload as `previous`/`next`, so a future auditor can see the
   * operator was warned and proceeded, not that the check silently didn't fire. Omitted entirely
   * when the overcommit check never fired (the common case) — never written as `false`/`null`. */
  overcommitAcknowledged?: boolean
  estimatedPhysicalBytesAtTimeOfChange?: number
}

/**
 * Story 22.1 AC-5 — the single dual-write helper for a platform-operator quota change: upserts
 * `audit_storage_quota_config`, records the operator's action in `platform_audit_events` (the
 * primary record — an operator action belongs in the operator log), and records the SAME change
 * in the target org's own `audit_log_entries` via `audit.quota_configured` (so the tenant can see
 * its own budget change in its own compliance log). All three in one transaction; both audit
 * writes use the fail-closed wrappers. `audit.quota_configured` is a member of
 * QUOTA_REMEDIATION_EVENT_TYPES (quota-gate.ts), never SECURITY_CRITICAL_AUDIT_EVENT_TYPES — an
 * over-quota org must still be able to have its own quota raised (AC-11's deadlock-prevention
 * case). Story 22.3's operator-facing endpoint calls this same function rather than inventing a
 * second one.
 */
// Story 22.2 AC-13: `undefined` input means "leave the stored value for this field unchanged" —
// fall back to the existing raw DB value (not the resolved-to-default value) so a partial update
// never clobbers the other field's stored override.
function resolveUnchangedField(
  inputValue: number | null | undefined,
  existingRawValue: string | null | undefined
): number | null {
  if (inputValue !== undefined) return inputValue
  return existingRawValue != null ? Number(existingRawValue) : null
}

export async function setOrgAuditQuota(tx: Tx, input: SetOrgAuditQuotaInput): Promise<void> {
  // AC-8: this is a cross-org (platform-operator) write, so the caller's transaction carries no
  // org RLS context yet — set it to the TARGET org explicitly before touching its RLS-protected
  // config row, the same discipline writeHumanAuditEntry/writeSystemAuditEntry already use.
  await tx.execute(sql`SELECT set_config('app.current_org_id', ${input.orgId}, true)`)
  const previousQuotaBytes = await resolveEffectiveOrgQuotaBytes(tx, input.orgId)
  const previousWriteRatePerMinute = await resolveEffectiveOrgWriteRatePerMinute(tx, input.orgId)

  // Story 22.2 AC-13: an operator may set either field, or both, in one call. `undefined` means
  // "leave the stored value for this field unchanged" — read the RAW row (not the
  // resolved-to-default value) so an update that only touches one field never clobbers the
  // other's stored override with the env default or null.
  const existingRows = await tx.execute<{
    quota_bytes: string | null
    write_rate_per_minute: string | null
  }>(sql`
    SELECT quota_bytes, write_rate_per_minute FROM audit_storage_quota_config
     WHERE org_id = ${input.orgId}
  `)
  const existing = existingRows[0]
  const nextQuotaBytes = resolveUnchangedField(input.quotaBytes, existing?.quota_bytes)
  const nextWriteRatePerMinute = resolveUnchangedField(
    input.writeRatePerMinute,
    existing?.write_rate_per_minute
  )

  await tx
    .insert(auditStorageQuotaConfig)
    .values({
      orgId: input.orgId,
      quotaBytes: nextQuotaBytes,
      writeRatePerMinute: nextWriteRatePerMinute,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: auditStorageQuotaConfig.orgId,
      set: {
        quotaBytes: nextQuotaBytes,
        writeRatePerMinute: nextWriteRatePerMinute,
        updatedAt: new Date(),
      },
    })

  const nextEffectiveQuotaBytes = await resolveEffectiveOrgQuotaBytes(tx, input.orgId)
  const nextEffectiveWriteRatePerMinute = await resolveEffectiveOrgWriteRatePerMinute(
    tx,
    input.orgId
  )

  const changePayload = {
    previous: { quotaBytes: previousQuotaBytes, writeRatePerMinute: previousWriteRatePerMinute },
    next: {
      quotaBytes: nextEffectiveQuotaBytes,
      writeRatePerMinute: nextEffectiveWriteRatePerMinute,
    },
    // Story 22.3 AC-4: only present when the caller's overcommit check actually fired and was
    // explicitly acknowledged — omitted (not `overcommitAcknowledged: false`) otherwise.
    ...(input.overcommitAcknowledged !== undefined
      ? {
          overcommitAcknowledged: input.overcommitAcknowledged,
          estimatedPhysicalBytesAtTimeOfChange: input.estimatedPhysicalBytesAtTimeOfChange ?? null,
        }
      : {}),
  }

  await writePlatformAuditEntryOrFailClosed(tx, {
    operatorId: input.operatorId,
    actionType: PlatformAuditAction.AUDIT_QUOTA_CONFIGURED,
    targetOrgId: input.orgId,
    payload: changePayload,
    ipAddress: input.operatorIpAddress ?? null,
  })

  await writeSystemAuditEntryOrFailClosed(tx, {
    orgId: input.orgId,
    eventType: AuditEvent.AUDIT_QUOTA_CONFIGURED,
    resourceType: 'audit_storage_quota_config',
    payload: changePayload,
  })
}

// ================================================================================================
// Story 22.3 — the operator-facing surface's own display/derivation helpers. Neither of these is
// on any enforcement path (quota-gate.ts never imports from this section) — both are pure
// functions consumed by platform-admin/service.ts (GET display) and
// platform-admin/audit-quota-routes.ts (PUT enforcement of the overcommit bound only).
// ================================================================================================

export type OrgAuditState = 'unlimited' | 'ok' | 'warning' | 'critical' | 'blocked' | 'stale'

/**
 * Story 22.3 AC-2 — the ONE shared, exported function that computes an org's audit-storage
 * `state`. Both the API route/service and the web page must call this (indirectly, via the
 * server-provided field) rather than recomputing the precedence anywhere else. Precedence,
 * evaluated top-to-bottom, first match wins: `stale` > `unlimited` > `blocked` > `critical` >
 * `warning` > `ok`. `stale` deliberately outranks `unlimited` — see this story's own Design
 * Decision note (AC-2): a reconciliation outage means `bytesUsed` itself might be wrong, which is
 * strictly more informative to surface than "unlimited" even for an org with no quota configured.
 *
 * Threshold comparisons use integer/exact arithmetic (`bytesUsed * 100 >= 95 * quotaBytes`, not a
 * floating-point-derived percentage compared against `95`/`80` literals) so a value that lands
 * EXACTLY on a boundary via floating-point division never flips tiers due to a rounding artifact
 * (AC-1's Boundary Sweep finding).
 */
export function resolveOrgAuditState(input: {
  quotaBytes: number | null
  bytesUsed: number
  lastReconciledAt: Date | null
}): OrgAuditState {
  const staleAfterMs = env.AUDIT_ORG_USAGE_STALE_AFTER_HOURS * 60 * 60 * 1000
  const isStale =
    input.lastReconciledAt === null || Date.now() - input.lastReconciledAt.getTime() > staleAfterMs
  if (isStale) return 'stale'

  if (input.quotaBytes === null) return 'unlimited'

  // Defensive only — Story 22.1's schema CHECK rejects `quota_bytes <= 0` at the DB level, so a
  // zero/negative quota should be unreachable in practice, but this must not divide by zero (it
  // doesn't divide at all — every comparison below is integer multiplication, not division).
  const quotaBytes = input.quotaBytes
  if (input.bytesUsed >= quotaBytes) return 'blocked'
  if (input.bytesUsed * 100 >= 95 * quotaBytes) return 'critical'
  if (input.bytesUsed * 100 >= 80 * quotaBytes) return 'warning'
  return 'ok'
}

export type ComputeAuditQuotaAllocationInput = {
  /** SUM of every org's EFFECTIVE quota_bytes across every org with a FINITE effective quota
   * (unlimited orgs — no per-org row and no positive env default, or an explicit per-org NULL —
   * are excluded entirely; see AC-4's lower-bound rule), computed BEFORE the proposed change. */
  currentSumOfFiniteQuotaBytes: number
  /** The target org's own CURRENT effective quota contribution to that sum — `0` if the org is
   * currently unlimited (and therefore not already included in the sum) or if this is a
   * pure-display call with no specific target org. */
  targetOrgCurrentContributionBytes: number
  /** The proposed NEW quota value for the target org. `null`/`undefined` for a pure-display call
   * (no proposed change — the target org's contribution is left exactly as-is). */
  requestedBytes?: number | null
  /** Whether at least one org has an unlimited effective quota right now — feeds the response's
   * `allocationIncludesUnlimitedOrgs` lower-bound flag (AC-4/AC-7). */
  hasUnlimitedOrgs: boolean
}

export type AuditQuotaAllocationResult = {
  allocatedLogicalBytes: number
  estimatedPhysicalBytes: number
  instanceLimitBytes: number
  thresholdBytes: number
  overThreshold: boolean
  allocationIncludesUnlimitedOrgs: boolean
}

/**
 * Story 22.3 AC-4/AC-7 — the SINGLE shared aggregate-allocation (overcommit) calculation, used
 * both by the `GET /admin/resource-usage` display path (no proposed change — `requestedBytes`
 * omitted) and the `PUT /admin/orgs/:orgId/audit-quota` enforcement path (a real proposed value).
 * Pure/synchronous — all DB reads happen at the call site; this function only does arithmetic, so
 * there is exactly one place the formula lives, per AC-4's own explicit "reuse the shared
 * calculation function" requirement (AC-7).
 *
 * This constant (`AUDIT_ORG_QUOTA_PHYSICAL_OVERHEAD_ESTIMATE`) and this function influence ONLY
 * this display/allocation check — never `assertOrgMayWriteAudit()`'s gate statement (AC-4's own
 * edge case; do not import this function from quota-gate.ts for any reason).
 */
export type OrgQuotaAllocationAggregate = {
  /** SUM of every OTHER org's effective quota_bytes (finite only) — the target org's own current
   * contribution is deliberately excluded here (returned separately below) so a caller can
   * substitute the PROPOSED value in without double-counting (see computeAuditQuotaAllocation()'s
   * own doc comment for why the delta must be computed this way). */
  sumOfFiniteQuotaBytesExcludingTarget: number
  hasUnlimitedOrgs: boolean
  targetOrgCurrentContributionBytes: number
}

/**
 * Story 22.3 AC-4 — a single aggregate query (mirrors the precedence CASE expressions
 * `resolveAuditStorageByOrg()`'s own query uses, for the same one-round-trip reason) computing
 * every input `computeAuditQuotaAllocation()` needs for the write-time overcommit check. Runs
 * inside the SAME transaction the route's `beginSecureMutation()`/`setOrgAuditQuota()` pattern
 * already opens.
 */
export async function resolveOrgQuotaAllocationAggregate(
  tx: Pick<Tx, 'execute'>,
  targetOrgId: string
): Promise<OrgQuotaAllocationAggregate> {
  const rows = await tx.execute<{
    sum_finite_excluding_target: string
    has_unlimited: boolean
    target_contribution: string
  }>(sql`
    WITH resolved AS (
      SELECT
        o.id AS org_id,
        CASE
          WHEN q.org_id IS NOT NULL THEN q.quota_bytes
          WHEN ${env.AUDIT_ORG_DEFAULT_STORAGE_QUOTA_MB}::bigint > 0
            THEN ${env.AUDIT_ORG_DEFAULT_STORAGE_QUOTA_MB}::bigint * 1048576
          ELSE NULL
        END AS effective_quota_bytes
      FROM organizations o
      LEFT JOIN audit_storage_quota_config q ON q.org_id = o.id
    )
    SELECT
      COALESCE(
        SUM(effective_quota_bytes) FILTER (
          WHERE effective_quota_bytes IS NOT NULL AND org_id != ${targetOrgId}
        ), 0
      ) AS sum_finite_excluding_target,
      BOOL_OR(effective_quota_bytes IS NULL) AS has_unlimited,
      COALESCE(
        (SELECT effective_quota_bytes FROM resolved WHERE org_id = ${targetOrgId}), 0
      ) AS target_contribution
    FROM resolved
  `)
  const row = rows[0]
  return {
    sumOfFiniteQuotaBytesExcludingTarget: Number(row?.sum_finite_excluding_target ?? 0),
    hasUnlimitedOrgs: Boolean(row?.has_unlimited ?? false),
    targetOrgCurrentContributionBytes: Number(row?.target_contribution ?? 0),
  }
}

export function computeAuditQuotaAllocation(
  input: ComputeAuditQuotaAllocationInput
): AuditQuotaAllocationResult {
  const proposedContribution =
    input.requestedBytes === null || input.requestedBytes === undefined
      ? input.targetOrgCurrentContributionBytes
      : input.requestedBytes

  const allocatedLogicalBytes =
    input.currentSumOfFiniteQuotaBytes -
    input.targetOrgCurrentContributionBytes +
    proposedContribution

  const estimatedPhysicalBytes =
    allocatedLogicalBytes * env.AUDIT_ORG_QUOTA_PHYSICAL_OVERHEAD_ESTIMATE
  const instanceLimitBytes = env.AUDIT_LOG_STORAGE_LIMIT_GB * 1024 ** 3
  const thresholdBytes = 0.8 * instanceLimitBytes

  return {
    allocatedLogicalBytes,
    estimatedPhysicalBytes,
    instanceLimitBytes,
    thresholdBytes,
    overThreshold: estimatedPhysicalBytes > thresholdBytes,
    allocationIncludesUnlimitedOrgs: input.hasUnlimitedOrgs,
  }
}
