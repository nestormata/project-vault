import { asc, eq, sql } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import {
  platformAuditMaintenanceState,
  platformAuditPendingEntries,
} from '@project-vault/db/schema'
import { writePlatformAuditEntry, type PlatformAuditFields } from './write-entry.js'

export class MaintenanceModeAlreadyActiveError extends Error {
  constructor() {
    super('platform audit maintenance mode is already active')
  }
}

/** AC-16 edge case: an operator explicitly requests deactivation while the log is still
 * genuinely unavailable — the route maps this to a 503, `active` remains `true`. */
export class MaintenanceModeStillUnavailableError extends Error {
  constructor() {
    super('Cannot deactivate maintenance mode: platform audit log is still unavailable')
  }
}

export async function isMaintenanceModeActive(tx: Tx): Promise<boolean> {
  const [row] = await tx
    .select({ active: platformAuditMaintenanceState.active })
    .from(platformAuditMaintenanceState)
    .limit(1)
  return row?.active ?? false
}

export type ActivateMaintenanceModeInput = { reason: string; userId: string }
export type ActivateMaintenanceModeResult = { active: true; activatedAt: Date; reason: string }

/** AC-14: activates maintenance mode. Row-locked (FOR UPDATE) so two concurrent activation
 * attempts cannot both observe `active: false` and both "win". */
export async function activateMaintenanceMode(
  tx: Tx,
  input: ActivateMaintenanceModeInput
): Promise<ActivateMaintenanceModeResult> {
  const [row] = await tx.select().from(platformAuditMaintenanceState).for('update').limit(1)

  if (row?.active) throw new MaintenanceModeAlreadyActiveError()

  const activatedAt = new Date()
  await tx
    .update(platformAuditMaintenanceState)
    .set({
      active: true,
      reason: input.reason,
      activatedByUserId: input.userId,
      activatedAt,
      deactivatedAt: null,
    })
    .where(eq(platformAuditMaintenanceState.id, 1))

  return { active: true, activatedAt, reason: input.reason }
}

/** D8: queues a write attempt that failed while maintenance mode is active. `sequenceNum` is
 * drawn from the dedicated `platform_audit_pending_seq` sequence so FIFO drain order is
 * guaranteed even under concurrent writers (AC-19). `attemptedAt` defaults to "now" but accepts
 * an override purely so tests can construct a deterministic drain-ordering fixture. */
export async function queuePendingEntry(
  tx: Tx,
  intendedFields: Record<string, unknown>,
  attemptedAt?: Date
): Promise<void> {
  const [seqRow] = await tx.execute<{ nextval: string }>(
    sql`SELECT nextval('platform_audit_pending_seq') AS nextval`
  )
  const sequenceNum = Number(seqRow?.nextval ?? 0)
  await tx.insert(platformAuditPendingEntries).values({
    intendedFields,
    sequenceNum,
    ...(attemptedAt ? { attemptedAt } : {}),
  })
}

export type DrainResult = { drained: number; skipped: boolean }

/**
 * AC-16: drains `platform_audit_pending_entries` FIFO into real `platform_audit_events` rows
 * (each stamped with its original `attemptedAt` and `payload.recordedRetroactively: true`).
 * Deactivates maintenance mode and writes a fresh (non-queued) `maintenance_mode.deactivated` row
 * ONLY when there was actually something to drain (`drained > 0`) — a proactive activation (AC-14
 * example) that never queued anything must stay active until an operator explicitly deactivates
 * it (see `deactivateMaintenanceMode`, which forces deactivation even with nothing pending). Row-
 * locks `platform_audit_maintenance_state` first — `skipLocked: true` (used by the opportunistic
 * auto-drain triggered from every successful write) makes a concurrent drain attempt a safe no-op
 * instead of blocking or double-draining; the explicit deactivate endpoint uses a blocking lock
 * (`skipLocked: false`, default) since draining is the entire point of that request.
 */
export async function drainPendingEntries(
  tx: Tx,
  triggeringOperatorId: string,
  opts: { skipLocked?: boolean } = {}
): Promise<DrainResult> {
  const query = tx.select().from(platformAuditMaintenanceState).limit(1)
  const [row] = opts.skipLocked
    ? await query.for('update', { skipLocked: true })
    : await query.for('update')

  if (!row) return { drained: 0, skipped: true }
  if (!row.active) return { drained: 0, skipped: false }

  const pending = await tx
    .select()
    .from(platformAuditPendingEntries)
    .orderBy(asc(platformAuditPendingEntries.sequenceNum))

  for (const entry of pending) {
    const fields = entry.intendedFields as PlatformAuditFields
    await writePlatformAuditEntry(tx, {
      ...fields,
      payload: { ...fields.payload, recordedRetroactively: true },
      createdAt: entry.attemptedAt,
    })
    await tx.delete(platformAuditPendingEntries).where(eq(platformAuditPendingEntries.id, entry.id))
  }

  if (pending.length > 0) {
    await tx
      .update(platformAuditMaintenanceState)
      .set({ active: false, deactivatedAt: new Date() })
      .where(eq(platformAuditMaintenanceState.id, 1))

    await writePlatformAuditEntry(tx, {
      operatorId: triggeringOperatorId,
      actionType: 'maintenance_mode.deactivated',
      payload: {},
    })
  }

  return { drained: pending.length, skipped: false }
}

/** Shared by `deactivateMaintenanceMode`'s "nothing was ever queued" branch: forces
 * deactivation by attempting a real write (proving the log is genuinely available) before
 * flipping the flag — never silently declares recovery the system hasn't verified. */
async function forceDeactivateWithFreshWrite(tx: Tx, operatorId: string): Promise<void> {
  await tx
    .update(platformAuditMaintenanceState)
    .set({ active: false, deactivatedAt: new Date() })
    .where(eq(platformAuditMaintenanceState.id, 1))

  await writePlatformAuditEntry(tx, {
    operatorId,
    actionType: 'maintenance_mode.deactivated',
    payload: {},
  })
}

export type DeactivateMaintenanceModeResult = { active: false; deactivatedAt: Date }

/** AC-16: operator-initiated deactivation (`POST /platform/maintenance-mode { action:
 * 'deactivate' }`). Any failure during the drain-and-deactivate attempt (the log is still
 * genuinely unavailable) is rewrapped as `MaintenanceModeStillUnavailableError` — `active` is
 * left untouched (still `true`) since the transaction rolls back on throw. */
export async function deactivateMaintenanceMode(
  tx: Tx,
  operatorId: string
): Promise<DeactivateMaintenanceModeResult> {
  const active = await isMaintenanceModeActive(tx)
  if (!active) return { active: false, deactivatedAt: new Date() }

  try {
    const result = await drainPendingEntries(tx, operatorId, { skipLocked: false })
    // Nothing was queued (AC-14 proactive-activation case) — drainPendingEntries left `active`
    // untouched; force deactivation here, still gated on a real write actually succeeding.
    if (result.drained === 0) await forceDeactivateWithFreshWrite(tx, operatorId)
  } catch {
    throw new MaintenanceModeStillUnavailableError()
  }

  return { active: false, deactivatedAt: new Date() }
}
