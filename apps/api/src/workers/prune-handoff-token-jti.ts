import { lt } from 'drizzle-orm'
import { getDb } from '@project-vault/db'
import { handoffPendingStates, handoffTokenJti } from '@project-vault/db/schema'
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
 * Story 30.2 AC5.20: the prepare-time pending-handoff state (its own table, per Task 2's design
 * decision) also needs an independent expiry sweep — it is never burned/consumed by the confirm
 * route (only the JTI is), so an abandoned prepare (user never confirms) would otherwise leave an
 * orphaned row forever.
 */
export async function pruneHandoffPendingStates(logger?: WorkerLogger): Promise<void> {
  await runPruneJob(
    'prune-handoff-pending-states',
    () =>
      getDb().delete(handoffPendingStates).where(lt(handoffPendingStates.expiresAt, new Date())),
    logger
  )
}
