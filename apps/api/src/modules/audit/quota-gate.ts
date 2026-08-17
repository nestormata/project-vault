import { sql } from 'drizzle-orm'
import { Counter, register } from 'prom-client'
import { withOrg, type Tx } from '@project-vault/db'
import { AuditEvent, OperationalEvent } from '@project-vault/shared'
import { env } from '../../config/env.js'
import { SameTransactionAuditWriteError } from '../../lib/secure-route.js'
import { isSecurityCriticalAuditEventType } from './maintenance-mode.js'

/** Some test files (e.g. session-revoke.test.ts) call `vi.resetModules()` and dynamically
 * re-import a module in this file's transitive import chain per test, which would otherwise
 * re-run `new Counter(...)` against prom-client's process-wide singleton `register` and throw
 * "already registered". Registration is idempotent instead: reuse the existing metric of the
 * same name if the module graph has already registered one. */
function getOrCreateCounter<T extends string = string>(
  config: ConstructorParameters<typeof Counter<T>>[0]
): Counter<T> {
  const existing = register.getSingleMetric(config.name)
  if (existing instanceof Counter) return existing as Counter<T>
  return new Counter(config)
}

// Story 22.1 AC-19: per-org audit-storage-quota gate outcomes, registered directly on
// prom-client's shared default registry (picked up by GET /metrics automatically). `reason` is
// one of `quota_exhausted` | `gate_unavailable` (the storage gate, above) or, as of Story 22.2,
// `rate_limited` (the independent rate gate, below) — the deleted instance breaker's
// `instance_critical` is the only state that is no longer reachable. No `org_id` label anywhere
// here — unbounded cardinality; org attribution lives in structured logs and in the AC-26/22.2
// durable counters on the org's own usage row.
export const auditWriteRefusedTotal = getOrCreateCounter<'reason'>({
  name: 'audit_write_refused_total',
  help: 'Audited writes refused by the per-org audit-storage quota gate',
  labelNames: ['reason'],
})

export const auditQuotaExemptWriteAdmittedTotal = getOrCreateCounter<'exemption_class'>({
  name: 'audit_quota_exempt_write_admitted_total',
  help: 'Audited writes admitted over an org quota because their event type is exempt',
  labelNames: ['exemption_class'],
})

export const auditPreauthVolumeAdmittedTotal = getOrCreateCounter({
  name: 'audit_preauth_volume_admitted_bytes_total',
  help: 'Logical bytes of pre-auth-attributable audit volume admitted (never an enforcement input)',
})

/**
 * Story 22.1 AC-29 — every audit event type an UNAUTHENTICATED or pre-session caller can cause to
 * be written. Their bytes are accumulated in `preauth_bytes_used`, which is NEVER an input to any
 * refusal decision for any org (the tenant-DoS amplifier this AC exists to close). Adding a new
 * security-critical event type later? Ask "can an unauthenticated caller trigger this?" first —
 * if yes, it belongs here too, or the vulnerability returns.
 */
export const PREAUTH_ATTRIBUTABLE_EVENT_TYPES: ReadonlySet<string> = new Set([
  AuditEvent.LOGIN_FAILED,
  AuditEvent.ACCOUNT_RECOVERY_REQUESTED,
  AuditEvent.ACCOUNT_RECOVERY_LINK_SENT,
  AuditEvent.ACCOUNT_RECOVERY_BLOCKED,
])

/**
 * Story 22.1 AC-28 — events an org must be able to emit in order to get itself back under quota.
 * Exempt from refusal, full stop (never "still rate-limited normally" — there is no rate
 * dimension left in this story). Separate from SECURITY_CRITICAL_AUDIT_EVENT_TYPES: this set
 * answers "does an over-quota org need this to get back under quota?", not "is this
 * security-sensitive?". Task 1's re-audit: the exact constant names used by the retention and
 * forwarding config routes (apps/api/src/modules/audit/routes.ts) are the raw string literals
 * 'audit.retention_configured' / 'audit.forwarding_configured' — neither is registered in the
 * AuditEvent registry today, which is pre-existing drift this story does not attempt to fix.
 */
export const QUOTA_REMEDIATION_EVENT_TYPES: ReadonlySet<string> = new Set([
  AuditEvent.AUDIT_QUOTA_CONFIGURED,
  'audit.retention_configured',
  'audit.forwarding_configured',
])

export type AuditWriteExemptionClass = 'security_critical' | 'preauth' | 'remediation' | null

/** AC-11: which of the three exempt classes (if any) an event type belongs to. Order matters only
 * for the preauth/security-critical overlap: PREAUTH_ATTRIBUTABLE_EVENT_TYPES is checked first so
 * an unauthenticated-triggerable event is NEVER accounted to the enforced counter, even though
 * every current member also happens to be in SECURITY_CRITICAL_AUDIT_EVENT_TYPES. */
export function classifyAuditWriteExemption(eventType: string): AuditWriteExemptionClass {
  if (PREAUTH_ATTRIBUTABLE_EVENT_TYPES.has(eventType)) return 'preauth'
  if (QUOTA_REMEDIATION_EVENT_TYPES.has(eventType)) return 'remediation'
  if (isSecurityCriticalAuditEventType(eventType)) return 'security_critical'
  return null
}

/**
 * AC-27: an in-process approximation of the entry's LOGICAL byte size — no `pg_column_size` call
 * is issued (that would be a second statement, defeating AC-6/AC-20's one-round-trip budget).
 * Dominated by the JSON payload, which is what actually varies in size across event types; the
 * fixed-column overhead below is a conservative constant rather than a measured figure. Byte
 * length (not character length) so multi-byte payload content is not under-counted.
 */
const FIXED_ROW_OVERHEAD_BYTES = 256

export function estimateAuditEntrySizeBytes(input: {
  payload: Record<string, unknown>
  resourceId?: string
  resourceType?: string
  revealedFields?: string[]
}): number {
  const payloadBytes = Buffer.byteLength(JSON.stringify(input.payload ?? {}), 'utf8')
  const resourceBytes = (input.resourceId?.length ?? 0) + (input.resourceType?.length ?? 0)
  const revealedFieldsBytes = input.revealedFields
    ? Buffer.byteLength(JSON.stringify(input.revealedFields), 'utf8')
    : 0
  return FIXED_ROW_OVERHEAD_BYTES + payloadBytes + resourceBytes + revealedFieldsBytes
}

type GateResult = { admitted: boolean; preauth: boolean }

/**
 * Story 22.1 AC-6/AC-9 — the single atomic conditional gate statement. Resolves the org's
 * effective quota (AC-4 precedence: per-org non-NULL row wins outright, including an explicit
 * NULL = unlimited that overrides the env default; otherwise the env default if > 0; otherwise
 * unlimited) INSIDE this one statement via a CTE, so there is no separate config read and no
 * cache (AC-9's "no stale cache" requirement). Both the INSERT and the UPDATE arms are guarded by
 * the same predicate (NF-20 fix) so a first write larger than the quota is refused, not admitted
 * unconditionally. Zero rows returned means refused.
 */
async function runGateStatement(
  tx: Tx,
  params: { orgId: string; sizeBytes: number; exempt: boolean; preauth: boolean }
): Promise<GateResult> {
  const rows = await tx.execute<{ bytes_used: string; preauth_bytes_used: string }>(sql`
    WITH cfg AS (
      SELECT quota_bytes FROM audit_storage_quota_config WHERE org_id = ${params.orgId}
    ),
    resolved AS (
      SELECT CASE
        WHEN EXISTS (SELECT 1 FROM cfg) THEN (SELECT quota_bytes FROM cfg)
        WHEN ${env.AUDIT_ORG_DEFAULT_STORAGE_QUOTA_MB}::bigint > 0
          THEN ${env.AUDIT_ORG_DEFAULT_STORAGE_QUOTA_MB}::bigint * 1048576
        ELSE NULL
      END AS quota
    )
    INSERT INTO audit_org_storage_usage AS u (org_id, bytes_used, preauth_bytes_used, entry_count, updated_at)
    SELECT ${params.orgId},
           CASE WHEN ${params.preauth} THEN 0 ELSE ${params.sizeBytes} END,
           CASE WHEN ${params.preauth} THEN ${params.sizeBytes} ELSE 0 END,
           1, now()
     WHERE ${params.exempt} OR ${params.preauth}
        OR (SELECT quota FROM resolved) IS NULL
        OR ${params.sizeBytes} <= (SELECT quota FROM resolved)
    ON CONFLICT (org_id) DO UPDATE
       SET bytes_used         = u.bytes_used + CASE WHEN ${params.preauth} THEN 0 ELSE ${params.sizeBytes} END,
           preauth_bytes_used = u.preauth_bytes_used + CASE WHEN ${params.preauth} THEN ${params.sizeBytes} ELSE 0 END,
           entry_count        = u.entry_count + 1,
           updated_at         = now()
     WHERE ${params.exempt} OR ${params.preauth}
        OR (SELECT quota FROM resolved) IS NULL
        OR u.bytes_used + ${params.sizeBytes} <= (SELECT quota FROM resolved)
    RETURNING u.bytes_used, u.preauth_bytes_used
  `)
  return { admitted: rows.length > 0, preauth: params.preauth }
}

/**
 * Story 22.1 AC-26 — best-effort, on a separate connection, AFTER the refusing transaction has
 * rolled back (this function is only ever called from the 503 error path, never from inside the
 * refusing transaction — the gate statement that returned zero rows incremented nothing). Swallows
 * its own failure: no audit record is at stake here, only an operational counter, which is the ONE
 * place in this story catch-and-continue is correct (AC-10 governs everything else).
 */
export async function recordAuditQuotaRefusalBestEffort(orgId: string): Promise<void> {
  try {
    await withOrg(orgId, (tx) =>
      tx.execute(sql`
        UPDATE audit_org_storage_usage
           SET refused_write_count = refused_write_count + 1, last_refusal_at = now(), updated_at = now()
         WHERE org_id = ${orgId}
      `)
    )
  } catch (error) {
    // AC-26: no FastifyBaseLogger reference exists at this call site (same discipline as
    // maintenance-mode.ts's now-deleted logAuditWriteSuspended) — direct stdout write.
    process.stdout.write(
      `${JSON.stringify({
        event: OperationalEvent.AUDIT_QUOTA_REFUSAL_RECORD_FAILED,
        level: 'warn',
        orgId,
        err: error instanceof Error ? error.message : String(error),
      })}\n`
    )
  }
}

/**
 * Story 22.1 — the single gate primitive all nine audit-write sites call immediately before their
 * INSERT, inside the caller's own transaction. `Promise<void>`, throw-or-succeed, never a boolean
 * (AC-10) — there is no "skip this write" return value in this API. `orgId` is taken explicitly
 * (never read from RLS session state) because `system-audit-row.ts` sets no RLS context of its
 * own (AC-13).
 */
export async function assertOrgMayWriteAudit(
  tx: Tx,
  input: { orgId: string; eventType: string; sizeBytes: number }
): Promise<void> {
  // AC-25/AC-20: the kill switch is an in-process boolean read, before any DB access. Off (the
  // default) costs exactly zero additional statements.
  if (!env.AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED) return

  const exemptionClass = classifyAuditWriteExemption(input.eventType)
  const exempt = exemptionClass === 'security_critical' || exemptionClass === 'remediation'
  const preauth = exemptionClass === 'preauth'

  let result: GateResult
  try {
    result = await runGateStatement(tx, {
      orgId: input.orgId,
      sizeBytes: input.sizeBytes,
      exempt,
      preauth,
    })
  } catch (error) {
    throw new SameTransactionAuditWriteError(
      error instanceof Error ? error.message : String(error),
      'audit_gate_unavailable'
    )
  }

  if (preauth) {
    auditPreauthVolumeAdmittedTotal.inc(input.sizeBytes)
  } else if (exempt) {
    auditQuotaExemptWriteAdmittedTotal.inc({ exemption_class: exemptionClass })
  }

  if (!result.admitted) {
    auditWriteRefusedTotal.inc({ reason: 'quota_exhausted' })
    throw new SameTransactionAuditWriteError(
      `audit storage quota exhausted for org ${input.orgId}`,
      'audit_quota_exhausted'
    )
  }
}

// ---------------------------------------------------------------------------------------------
// Story 22.2 — the SECOND, independent gate: per-org write-RATE (throughput) limiting. Runs
// alongside (not merged into) assertOrgMayWriteAudit above, at each of the same nine insert
// sites, immediately BEFORE the storage gate (the documented ordering decision — a rate-refused
// request never has its size estimated or attributed to the storage counter). Colocated on the
// SAME `audit_org_storage_usage` row (no new table — see the Design Decision section of Story
// 22.2's story file / docs/operations/audit-quota-degradation-strategy.md's addendum).
// ---------------------------------------------------------------------------------------------

type RateGateResult = { admitted: boolean; preauth: boolean }

/**
 * Story 22.2 AC-5/AC-8 — the single atomic conditional gate statement for the rate axis. Mirrors
 * runGateStatement()'s shape exactly: one round trip, both the INSERT and UPDATE arms guarded by
 * the same predicate (the NF-20 fix, applied fresh here rather than copy-pasted from an earlier,
 * unguarded draft), zero rows returned means refused. All window-boundary comparisons use the
 * DATABASE server's clock (`now()`), never the API process's clock, computed entirely inside this
 * one statement — see the story's clock-consistency requirement.
 */
async function runRateGateStatement(
  tx: Tx,
  params: { orgId: string; windowMs: number; exempt: boolean; preauth: boolean }
): Promise<RateGateResult> {
  const rows = await tx.execute<{
    rate_window_count: string
    rate_window_reset_at: string | null
  }>(sql`
    WITH cfg AS (
      SELECT write_rate_per_minute FROM audit_storage_quota_config WHERE org_id = ${params.orgId}
    ),
    resolved AS (
      SELECT CASE
        WHEN EXISTS (SELECT 1 FROM cfg) AND (SELECT write_rate_per_minute FROM cfg) IS NOT NULL
          THEN (SELECT write_rate_per_minute FROM cfg)
        WHEN ${env.AUDIT_ORG_DEFAULT_WRITE_RATE_PER_MIN}::bigint > 0
          THEN ${env.AUDIT_ORG_DEFAULT_WRITE_RATE_PER_MIN}::bigint
        ELSE NULL
      END AS limit_per_window
    )
    INSERT INTO audit_org_storage_usage AS u
      (org_id, rate_window_count, rate_window_reset_at,
       preauth_rate_window_count, preauth_rate_window_reset_at, updated_at)
    SELECT ${params.orgId},
           CASE WHEN ${params.preauth} THEN 0 ELSE 1 END,
           CASE WHEN ${params.preauth} THEN NULL
                ELSE now() + (${params.windowMs} || ' ms')::interval END,
           CASE WHEN ${params.preauth} THEN 1 ELSE 0 END,
           CASE WHEN ${params.preauth} THEN now() + (${params.windowMs} || ' ms')::interval
                ELSE NULL END,
           now()
     WHERE ${params.exempt} OR ${params.preauth}
        OR (SELECT limit_per_window FROM resolved) IS NULL
        OR 1 <= (SELECT limit_per_window FROM resolved)
    ON CONFLICT (org_id) DO UPDATE
       SET rate_window_count = CASE
             WHEN ${params.preauth} THEN u.rate_window_count
             WHEN u.rate_window_reset_at IS NULL OR u.rate_window_reset_at <= now() THEN 1
             ELSE u.rate_window_count + 1
           END,
           rate_window_reset_at = CASE
             WHEN ${params.preauth} THEN u.rate_window_reset_at
             WHEN u.rate_window_reset_at IS NULL OR u.rate_window_reset_at <= now()
               THEN now() + (${params.windowMs} || ' ms')::interval
             ELSE u.rate_window_reset_at
           END,
           preauth_rate_window_count = CASE
             WHEN NOT ${params.preauth} THEN u.preauth_rate_window_count
             WHEN u.preauth_rate_window_reset_at IS NULL OR u.preauth_rate_window_reset_at <= now()
               THEN 1
             ELSE u.preauth_rate_window_count + 1
           END,
           preauth_rate_window_reset_at = CASE
             WHEN NOT ${params.preauth} THEN u.preauth_rate_window_reset_at
             WHEN u.preauth_rate_window_reset_at IS NULL OR u.preauth_rate_window_reset_at <= now()
               THEN now() + (${params.windowMs} || ' ms')::interval
             ELSE u.preauth_rate_window_reset_at
           END,
           updated_at = now()
     WHERE ${params.exempt} OR ${params.preauth}
        OR (SELECT limit_per_window FROM resolved) IS NULL
        OR (CASE
              WHEN u.rate_window_reset_at IS NULL OR u.rate_window_reset_at <= now() THEN 1
              ELSE u.rate_window_count + 1
            END) <= (SELECT limit_per_window FROM resolved)
    RETURNING u.rate_window_count, u.rate_window_reset_at
  `)
  return { admitted: rows.length > 0, preauth: params.preauth }
}

/**
 * Story 22.2 AC-9 — mirrors recordAuditQuotaRefusalBestEffort() exactly: best-effort, on a
 * separate connection, called ONLY from the 429 error path AFTER the refusing transaction has
 * already rolled back. Returns the current `rate_window_reset_at` converted to a
 * `retryAfterSeconds` figure (with a small amount of server-added jitter, AC-7's
 * thundering-herd mitigation) for secure-route.ts's 429 handler to set as the `Retry-After`
 * header — or `null` if the read/update itself fails, in which case the caller falls back to a
 * conservative default rather than omitting the header.
 */
export async function recordAuditRateRefusalBestEffort(
  orgId: string
): Promise<{ retryAfterSeconds: number } | null> {
  try {
    const rows = await withOrg(orgId, (tx) =>
      tx.execute<{ rate_window_reset_at: string | null }>(sql`
        UPDATE audit_org_storage_usage
           SET rate_refused_count = rate_refused_count + 1,
               last_rate_refusal_at = now(),
               updated_at = now()
         WHERE org_id = ${orgId}
        RETURNING rate_window_reset_at
      `)
    )
    const resetAt = rows[0]?.rate_window_reset_at
    if (!resetAt) return null
    const remainingMs = new Date(resetAt).getTime() - Date.now()
    const jitterSeconds = Math.random() * 0.5
    const retryAfterSeconds = Math.max(1, Math.ceil(remainingMs / 1000 + jitterSeconds))
    return { retryAfterSeconds }
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({
        event: OperationalEvent.AUDIT_RATE_REFUSAL_RECORD_FAILED,
        level: 'warn',
        orgId,
        err: error instanceof Error ? error.message : String(error),
      })}\n`
    )
    return null
  }
}

/**
 * Story 22.2 AC-4 — the second gate primitive, called immediately BEFORE assertOrgMayWriteAudit()
 * at every one of the same nine insert sites, inside the SAME already-open transaction, after
 * setRlsOrgContext() has run. Throw-or-succeed, never a boolean, same contract as the storage
 * gate. `orgId` is taken explicitly — never re-derived from request body/query/headers at any
 * call site (the non-influenceability invariant).
 */
export async function assertOrgMayWriteAuditAtRate(
  tx: Tx,
  input: { orgId: string; eventType: string }
): Promise<void> {
  // AC-3: the kill switch is an in-process boolean read, before any DB access. Off (the default)
  // costs exactly zero additional statements — independent of AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED.
  if (!env.AUDIT_ORG_WRITE_RATE_ENFORCEMENT_ENABLED) return

  const exemptionClass = classifyAuditWriteExemption(input.eventType)
  const exempt = exemptionClass === 'security_critical' || exemptionClass === 'remediation'
  const preauth = exemptionClass === 'preauth'

  let result: RateGateResult
  try {
    result = await runRateGateStatement(tx, {
      orgId: input.orgId,
      windowMs: env.AUDIT_ORG_WRITE_RATE_WINDOW_MS,
      exempt,
      preauth,
    })
  } catch (error) {
    throw new SameTransactionAuditWriteError(
      error instanceof Error ? error.message : String(error),
      'audit_gate_unavailable'
    )
  }

  if (!preauth && exempt) {
    auditQuotaExemptWriteAdmittedTotal.inc({ exemption_class: exemptionClass })
  }

  if (!result.admitted) {
    auditWriteRefusedTotal.inc({ reason: 'rate_limited' })
    process.stdout.write(
      `${JSON.stringify({
        event: OperationalEvent.AUDIT_RATE_LIMIT_WRITE_REFUSED,
        level: 'warn',
        orgId: input.orgId,
        eventType: input.eventType,
        windowMs: env.AUDIT_ORG_WRITE_RATE_WINDOW_MS,
      })}\n`
    )
    throw new SameTransactionAuditWriteError(
      `audit write rate limit exceeded for org ${input.orgId}`,
      'audit_rate_limited'
    )
  }
}
