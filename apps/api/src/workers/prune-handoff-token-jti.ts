import { lt } from 'drizzle-orm'
import { getDb } from '@project-vault/db'
import { handoffNonces, handoffPendingStates, handoffTokenJti } from '@project-vault/db/schema'
import { runPruneJob, type WorkerLogger } from './prune-utils.js'

/**
 * Story 30.2 AC5: modeled directly on `prune-revoked-tokens.ts`'s `runPruneJob` shape. Deletes
 * `handoff_token_jti` rows past their `expires_at` — safe by construction (AC5.19): `expires_at`
 * is set at insert time to `now() + 120s`, so a freshly-burned row is never a sweep target until
 * its replay window has already closed.
 */
export async function pruneHandoffTokenJti(logger?: WorkerLogger): Promise<void> {
  await runPruneJob(
    'prune-handoff-token-jti',
    () => getDb().delete(handoffTokenJti).where(lt(handoffTokenJti.expiresAt, new Date())),
    logger
  )
}

/**
 * Story 73.1: nonce records live 120 s. A consumed row is kept until it expires (so a second
 * presentation reads as reused), then this sweep deletes it like an abandoned one.
 */
export async function pruneHandoffNonces(logger?: WorkerLogger): Promise<void> {
  await runPruneJob(
    'prune-handoff-nonces',
    () => getDb().delete(handoffNonces).where(lt(handoffNonces.expiresAt, new Date())),
    logger
  )
  // The retired handoff_pending_states table stays until its reviewed drop migration lands; rows
  // written before the upgrade still carry token claims, so they keep being swept here.
  await runPruneJob(
    'prune-handoff-pending-states-leftovers',
    () =>
      getDb().delete(handoffPendingStates).where(lt(handoffPendingStates.expiresAt, new Date())),
    logger
  )
}

/** pg-boss keeps schedules across deploys, so the retired pending-state sweep is unscheduled at
 *  boot (idempotent), the same way main.ts retires the old notification catch-ups. */
export const RETIRED_HANDOFF_PRUNE_SCHEDULES = ['prune-handoff-pending-states'] as const
