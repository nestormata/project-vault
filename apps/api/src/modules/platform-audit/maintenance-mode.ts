import { asc, eq, sql } from 'drizzle-orm'
import type { Tx, getDb } from '@project-vault/db'
import {
  platformAuditMaintenanceState,
  platformAuditPendingEntries,
} from '@project-vault/db/schema'
import { writePlatformAuditEntry, type PlatformAuditFields } from './write-entry.js'

type Db = ReturnType<typeof getDb>

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

export async function isMaintenanceModeActive(
  tx: Tx,
  opts: { forUpdate?: boolean } = {}
): Promise<boolean> {
  const query = tx
    .select({ active: platformAuditMaintenanceState.active })
    .from(platformAuditMaintenanceState)
    .limit(1)
  const [row] = opts.forUpdate ? await query.for('update') : await query
  return row?.active ?? false
}

export type MaintenanceModeStatus = {
  active: boolean
  reason: string | null
  activatedAt: Date | null
  deactivatedAt: Date | null
  pendingEntriesCount: number
}

type StateRow = typeof platformAuditMaintenanceState.$inferSelect

function rowToStatus(
  row: StateRow | undefined,
  pendingEntriesCount: number
): MaintenanceModeStatus {
  return {
    active: row?.active ?? false,
    reason: row?.reason ?? null,
    activatedAt: row?.activatedAt ?? null,
    deactivatedAt: row?.deactivatedAt ?? null,
    pendingEntriesCount,
  }
}

/** D2.4: reads the current maintenance-mode state plus the pending-entries queue count.
 * Read-only status endpoint with no mutation, so D2.4 intentionally does not require MFA. */
export async function getMaintenanceModeStatus(tx: Tx): Promise<MaintenanceModeStatus> {
  const [row] = await tx.select().from(platformAuditMaintenanceState).limit(1)
  const [countRow] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(platformAuditPendingEntries)
  return rowToStatus(row, countRow?.count ?? 0)
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

export type DrainResult = {
  drained: number
  /** Code review fix: entries that were attempted but could not be drained (still stuck in the
   * queue) — see the per-entry isolation note below. `deactivateMaintenanceMode` must not report
   * success while this is non-zero. */
  remaining: number
  skipped: boolean
  /** Code review fix: distinguishes "the row was already inactive when we locked it" (a
   * concurrent deactivate call already finished — AC-16's concurrent-drain-race scenario) from
   * "the row was active but had nothing queued" — both previously collapsed into the same
   * `{drained: 0, skipped: false}` shape, which made `deactivateMaintenanceMode` unable to tell
   * them apart and caused it to fire a second, spurious `maintenance_mode.deactivated` write for
   * a transition that had already happened under a concurrent call. */
  wasActive: boolean
}

/**
 * AC-16: drains `platform_audit_pending_entries` FIFO into real `platform_audit_events` rows
 * (each stamped with its original `attemptedAt` and `payload.recordedRetroactively: true`).
 * Deactivates maintenance mode and writes a fresh (non-queued) `maintenance_mode.deactivated` row
 * ONLY when there was actually something to drain AND every entry drained successfully
 * (`drained > 0 && remaining === 0`) — a proactive activation (AC-14 example) that never queued
 * anything must stay active until an operator explicitly deactivates it (see
 * `deactivateMaintenanceMode`, which forces deactivation even with nothing pending). Row-locks
 * `platform_audit_maintenance_state` first — `skipLocked: true` (used by the opportunistic
 * auto-drain triggered from every successful write) makes a concurrent drain attempt a safe no-op
 * instead of blocking or double-draining; the explicit deactivate endpoint uses a blocking lock
 * (`skipLocked: false`, default) since draining is the entire point of that request.
 *
 * Code review fix: each entry's write+delete runs in its own SAVEPOINT (`tx.transaction()`
 * nested inside an existing transaction becomes a real SAVEPOINT — same pattern as
 * `auth/service.ts`'s `allocateOrganizationSlug`). Without this, a single poisoned entry (a bad
 * payload shape, a redaction throw, any DB-level error) would abort the entire drain loop at the
 * Postgres level — and since the opportunistic auto-drain retries the same head-of-queue entry on
 * every future successful write, and the explicit deactivate endpoint retries it on every call,
 * one bad entry would otherwise permanently block both future drains AND maintenance-mode
 * deactivation with no way to recover short of manual DB surgery. A failed entry is left in place
 * (never silently dropped) for investigation and is retried on the next drain attempt.
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

  if (!row) return { drained: 0, remaining: 0, skipped: true, wasActive: false }
  if (!row.active) return { drained: 0, remaining: 0, skipped: false, wasActive: false }

  const pending = await tx
    .select()
    .from(platformAuditPendingEntries)
    .orderBy(asc(platformAuditPendingEntries.sequenceNum))

  let drained = 0
  for (const entry of pending) {
    const fields = entry.intendedFields as PlatformAuditFields
    try {
      await tx.transaction(async (savepointTx) => {
        const typedTx = savepointTx as Tx
        await writePlatformAuditEntry(typedTx, {
          ...fields,
          payload: { ...fields.payload, recordedRetroactively: true },
          createdAt: entry.attemptedAt,
        })
        await typedTx
          .delete(platformAuditPendingEntries)
          .where(eq(platformAuditPendingEntries.id, entry.id))
      })
      drained += 1
    } catch (error) {
      process.stderr.write(
        `[platform-audit] WARN: failed to drain pending entry ${entry.id} ` +
          `(sequence ${entry.sequenceNum}): ${error instanceof Error ? error.message : String(error)}\n`
      )
    }
  }

  const remaining = pending.length - drained
  if (drained > 0 && remaining === 0) {
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

  return { drained, remaining, skipped: false, wasActive: true }
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
 * left untouched (still `true`) in that case.
 *
 * Review fix (2026-07-11): `drainPendingEntries` isolates each entry in its own SAVEPOINT, but a
 * SAVEPOINT's work is only durable once the *enclosing* transaction commits. The previous
 * implementation ran the whole drain-and-decide sequence inside one outer transaction and threw
 * `MaintenanceModeStillUnavailableError` from inside it whenever any entry remained undrained —
 * that throw rolled back the entire outer transaction, discarding every SAVEPOINT that had
 * already been released for entries that DID drain successfully. This function now runs the
 * drain in its own top-level transaction (`db.transaction`, not a caller-supplied `tx`) so it
 * commits unconditionally once the loop finishes; the decision to throw
 * `MaintenanceModeStillUnavailableError` happens afterward, outside any transaction, so it can no
 * longer undo the drain's already-committed work.
 *
 * `drainPendingEntries` no longer throws on a partial/poisoned-entry failure (it isolates each
 * entry in its own SAVEPOINT and reports `remaining` instead) — this function must therefore
 * explicitly check `result.remaining` and refuse to report success while any entry is still
 * stuck, instead of the previous implicit "no throw = fully drained" assumption. It must also
 * check `result.wasActive`: if a concurrent deactivate call already finished the drain (AC-16
 * concurrent-drain-race), this call must not fire a second, spurious
 * `maintenance_mode.deactivated` write for a transition that already happened.
 */
export async function deactivateMaintenanceMode(
  db: Db,
  operatorId: string
): Promise<DeactivateMaintenanceModeResult> {
  const active = await db.transaction((tx) => isMaintenanceModeActive(tx))
  if (!active) return { active: false, deactivatedAt: new Date() }

  let result: DrainResult
  try {
    result = await db.transaction((tx) =>
      drainPendingEntries(tx, operatorId, { skipLocked: false })
    )
  } catch {
    throw new MaintenanceModeStillUnavailableError()
  }

  if (!result.wasActive) {
    // A concurrent deactivate call already drained/deactivated under our feet — nothing left to
    // do, and nothing further to write.
    return { active: false, deactivatedAt: new Date() }
  }

  if (result.drained === 0 && result.remaining === 0) {
    // Nothing was queued (AC-14 proactive-activation case) — drainPendingEntries left `active`
    // untouched; force deactivation here, still gated on a real write actually succeeding.
    try {
      await db.transaction((tx) => forceDeactivateWithFreshWrite(tx, operatorId))
    } catch {
      throw new MaintenanceModeStillUnavailableError()
    }
    return { active: false, deactivatedAt: new Date() }
  }

  if (result.remaining > 0) {
    // One or more pending entries could not be drained — maintenance mode is still genuinely
    // active; never falsely report success. The drain's transaction above has already committed,
    // though, so entries that DID drain successfully are durably gone from the queue even though
    // this call still reports "still unavailable" for the ones that didn't.
    throw new MaintenanceModeStillUnavailableError()
  }

  // drained > 0 && remaining === 0: drainPendingEntries already flipped `active` to false and
  // wrote the fresh `maintenance_mode.deactivated` row itself.
  return { active: false, deactivatedAt: new Date() }
}
