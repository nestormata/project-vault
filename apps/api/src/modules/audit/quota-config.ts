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
  const nextQuotaBytes =
    input.quotaBytes !== undefined
      ? input.quotaBytes
      : existing?.quota_bytes != null
        ? Number(existing.quota_bytes)
        : null
  const nextWriteRatePerMinute =
    input.writeRatePerMinute !== undefined
      ? input.writeRatePerMinute
      : existing?.write_rate_per_minute != null
        ? Number(existing.write_rate_per_minute)
        : null

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
