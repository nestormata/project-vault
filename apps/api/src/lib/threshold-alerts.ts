import { sql } from 'drizzle-orm'
import { getDb } from '@project-vault/db'
import { adminAlerts } from '@project-vault/db/schema'

export type ThresholdPct = 80 | 90 | 95

export type ThresholdAlertInput = {
  alertType: string
  thresholdPct: ThresholdPct
  severity: 'warning' | 'critical'
  payload: Record<string, unknown>
  /** Distinguishes independent episodes sharing the same `alertType` — e.g. an orgId for
   * per-org alerts (AC-13). `null` for a single, instance-wide episode (AC-14/AC-16/AC-19/20). */
  scopeKey: string | null
}

/**
 * Story 9.2 AC-13/AC-14/AC-16/AC-19/AC-20: reusable episode-key idempotency for tiered (80/90/95)
 * threshold alerts, generalizing Story 9.1's `createAdminAlertIfNotActive` per-alertType dedup to
 * also dedup per-threshold and per-scope (e.g. per org). Behavior:
 * - No active episode yet, or the active episode is below `thresholdPct`: acknowledges the old
 *   row (if any) and inserts a fresh active row at the new (higher) threshold — this is a "newly
 *   crossed" threshold, which must alert.
 * - An active episode already at or above `thresholdPct`: no-op (returns null) — already alerted
 *   at this level or higher, must not re-fire on every check tick.
 * Advisory-locked per (alertType, scopeKey) so concurrent check-job ticks can't race each other.
 */
export async function upsertThresholdAlert(
  input: ThresholdAlertInput
): Promise<{ id: string } | null> {
  const lockKey = `${input.alertType}:${input.scopeKey ?? 'instance'}`
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`)

    const scopeFilter =
      input.scopeKey === null
        ? sql`(payload->>'scopeKey') IS NULL`
        : sql`payload->>'scopeKey' = ${input.scopeKey}`

    const existingRows = await tx.execute<{ id: string; threshold_pct: number | null }>(sql`
      SELECT id, (payload->>'thresholdPct')::int AS threshold_pct
      FROM admin_alerts
      WHERE alert_type = ${input.alertType} AND status = 'active' AND ${scopeFilter}
      LIMIT 1
    `)
    const existing = existingRows[0]

    if (existing && (existing.threshold_pct ?? 0) >= input.thresholdPct) {
      return null
    }

    if (existing) {
      await tx.execute(
        sql`UPDATE admin_alerts SET status = 'acknowledged', acknowledged_at = now() WHERE id = ${existing.id}`
      )
    }

    const [row] = await tx
      .insert(adminAlerts)
      .values({
        alertType: input.alertType,
        severity: input.severity,
        payload: { ...input.payload, thresholdPct: input.thresholdPct, scopeKey: input.scopeKey },
        status: 'active',
      })
      .returning({ id: adminAlerts.id })
    return row ?? null
  })
}

/**
 * Acknowledges any active episode for (alertType, scopeKey) — called when utilization drops back
 * below the lowest tracked threshold (80%), so a future re-crossing creates a fresh alert instead
 * of being permanently suppressed by a stale "already alerted" row.
 */
export async function clearThresholdAlertEpisode(
  alertType: string,
  scopeKey: string | null
): Promise<void> {
  const scopeFilter =
    scopeKey === null
      ? sql`(payload->>'scopeKey') IS NULL`
      : sql`payload->>'scopeKey' = ${scopeKey}`
  await getDb().execute(sql`
    UPDATE admin_alerts SET status = 'acknowledged', acknowledged_at = now()
    WHERE alert_type = ${alertType} AND status = 'active' AND ${scopeFilter}
  `)
}
