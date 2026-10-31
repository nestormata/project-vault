import { and, eq, gt, isNull, sql } from 'drizzle-orm'
import { getDb } from '@project-vault/db'
import { handoffNonces, handoffTokenJti } from '@project-vault/db/schema'
import { HandoffEvent } from '@project-vault/shared'

/**
 * Story 73.1: the database seam of the nonce-bound handoff. A separate module so the claim route
 * tests can inject a store outage here while the burn and the consume stay real Postgres.
 */

export type NonceConsumeOutcome = 'consumed' | 'unknown' | 'reused' | 'expired'

export async function insertHandoffNonce(nonceHash: string, expiresAt: Date): Promise<void> {
  await getDb().insert(handoffNonces).values({ nonceHash, expiresAt })
}

/**
 * D5: consumes the nonce on first presentation, whatever happens to the token afterwards. One
 * conditional UPDATE decides it, so of two racing claims for the same nonce exactly one gets
 * `consumed`. A miss is classified by a follow-up read; the read cannot turn a miss into a
 * success. Throws on a store error (the caller fails closed).
 */
export async function consumeHandoffNonce(nonceHash: string): Promise<NonceConsumeOutcome> {
  const consumed = await getDb()
    .update(handoffNonces)
    .set({ consumedAt: sql`now()` })
    .where(
      and(
        eq(handoffNonces.nonceHash, nonceHash),
        isNull(handoffNonces.consumedAt),
        gt(handoffNonces.expiresAt, sql`now()`)
      )
    )
    .returning({ nonceHash: handoffNonces.nonceHash })
  if (consumed.length === 1) return 'consumed'

  const [row] = await getDb()
    .select({ consumedAt: handoffNonces.consumedAt })
    .from(handoffNonces)
    .where(eq(handoffNonces.nonceHash, nonceHash))
    .limit(1)
  if (!row) return 'unknown'
  return row.consumedAt ? 'reused' : 'expired'
}

type JtiBurnErrorEvent =
  typeof HandoffEvent.HANDOFF_REPLAY | typeof HandoffEvent.HANDOFF_REPLAY_STORE_UNAVAILABLE

function pgErrorCode(error: unknown): string | undefined {
  // Drizzle 0.45 wraps driver errors in a DrizzleQueryError whose `.cause` carries the pg `code`.
  const shaped = error as { code?: string; cause?: { code?: string } } | null | undefined
  return shaped?.code ?? shaped?.cause?.code
}

/**
 * A unique violation on the jti primary key (`23505`) means the token was already burned: a
 * replay. Anything else (connection refused, pool exhausted, statement timeout) is the replay
 * store being unavailable, so the claim fails closed.
 */
export function classifyJtiBurnError(error: unknown): JtiBurnErrorEvent {
  if (pgErrorCode(error) === '23505') return HandoffEvent.HANDOFF_REPLAY
  return HandoffEvent.HANDOFF_REPLAY_STORE_UNAVAILABLE
}

/** Insert-first burn: the primary key IS the replay decision, never a SELECT-then-INSERT. */
export async function burnHandoffJti(jti: string, expiresAt: Date): Promise<void> {
  await getDb().insert(handoffTokenJti).values({ jti, expiresAt })
}
