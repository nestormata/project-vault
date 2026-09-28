import { and, eq } from 'drizzle-orm'
import { getDb, type Tx } from '@project-vault/db'
import { handoffPendingStates } from '@project-vault/db/schema'
import { HandoffEvent } from '@project-vault/shared'

/**
 * Story 60.5: the claim exchange's database seam.
 *
 * This module exists so the claim-exchange rollback tests
 * (`handoff-claim-exchange-atomicity.test.ts`) can inject a deterministic failure INSIDE the real
 * claim-exchange transaction, after the real burn `INSERT` has run against real Postgres (Design
 * Decision 2). The tests `vi.mock` this module with `importOriginal` and wrap these functions;
 * the burn and the transaction itself stay real.
 *
 * `rekeyPendingCookieHash()` must only ever be called with the claim-exchange transaction's own
 * `tx` — never `getDb()` — so the re-key commits or rolls back together with the burn.
 */

export type PendingRow = typeof handoffPendingStates.$inferSelect

/**
 * Story 60.3 AC3: scoped by BOTH `pendingId` and `claimHash` matching the SAME row — never
 * `claimHash` alone. A `claim` that is otherwise valid but paired with a different request's
 * `pendingId` in the URL must still fail; a lookup keyed only on `claimHash` would let an attacker
 * who observes one full valid `/handoff` URL swap in an unrelated `pendingId`. A row with a
 * `claim_hash` of `NULL` (a pre-60.3 row — the rolling-deploy skew case) can never match here,
 * since SQL equality against NULL is never true.
 *
 * Runs on the pool, outside (and before) the claim-exchange transaction: the common rejection
 * paths never open a transaction.
 */
export async function findPendingForClaim(
  pendingId: string,
  claimHash: string
): Promise<PendingRow | undefined> {
  const [row] = await getDb()
    .select()
    .from(handoffPendingStates)
    .where(
      and(eq(handoffPendingStates.id, pendingId), eq(handoffPendingStates.claimHash, claimHash))
    )
    .limit(1)
  return row
}

/**
 * Re-keys the pending row's `cookieHash` inside the claim-exchange transaction and returns how
 * many rows it updated (the caller requires exactly 1). Deliberately has no `try/catch`: any
 * error must propagate so the transaction aborts and the burn rolls back with it.
 */
export async function rekeyPendingCookieHash(
  tx: Tx,
  args: { pendingId: string; claimHash: string; cookieHash: string }
): Promise<number> {
  const rows = await tx
    .update(handoffPendingStates)
    .set({ cookieHash: args.cookieHash })
    .where(
      and(
        eq(handoffPendingStates.id, args.pendingId),
        eq(handoffPendingStates.claimHash, args.claimHash)
      )
    )
    .returning({ id: handoffPendingStates.id })
  return rows.length
}

/** Thrown inside the claim-exchange transaction when the re-key did not hit exactly one row (the
 *  pending row vanished between the lookup and the update). Rolls the burn back; classified as a
 *  replay (the row is effectively gone — same class as the lookup-miss branch). */
export class ClaimRekeyMissError extends Error {
  constructor() {
    super('claim exchange re-key did not match exactly one pending row')
    this.name = 'ClaimRekeyMissError'
  }
}

type ClaimExchangeErrorEvent =
  typeof HandoffEvent.HANDOFF_REPLAY | typeof HandoffEvent.HANDOFF_REPLAY_STORE_UNAVAILABLE

function pgErrorCode(error: unknown): string | undefined {
  // Drizzle 0.45 wraps driver errors in a DrizzleQueryError whose `.cause` carries the pg `code`.
  const shaped = error as { code?: string; cause?: { code?: string } } | null | undefined
  return shaped?.code ?? shaped?.cause?.code
}

/**
 * The single classifier shared by the claim-exchange transaction and `/confirm`'s `burnJti()`
 * (Design Decision 3), so the two paths can never classify differently. A unique violation on
 * the burn's primary key (`23505`) means the key was already burned — a replay. The re-key
 * sentinel is a replay too. Anything else (connection refused, pool exhausted, statement timeout,
 * a failed COMMIT) is the replay store being unavailable — fail closed.
 */
export function classifyClaimExchangeError(error: unknown): ClaimExchangeErrorEvent {
  if (error instanceof ClaimRekeyMissError) return HandoffEvent.HANDOFF_REPLAY
  if (pgErrorCode(error) === '23505') return HandoffEvent.HANDOFF_REPLAY
  return HandoffEvent.HANDOFF_REPLAY_STORE_UNAVAILABLE
}
