import { asc, inArray, lt, sql } from 'drizzle-orm'
import { delegationAssertionJti } from '@project-vault/db/schema'
import { getAdminDb } from '../lib/db.js'
import { defaultWorkerLogger, runPruneJob, type WorkerLogger } from './prune-utils.js'

/**
 * Story 71.7 AC-6 — reclaims storage from the delegation assertion burn ledger
 * (`delegation_assertion_jti`, FORCE RLS). Sibling of `pruneHandoffTokenJti`, same `runPruneJob`
 * wrapper.
 *
 * - ONE bounded `DELETE` per run over the admin (BYPASSRLS) pool, oldest first, at most
 *   `DELEGATION_JTI_PRUNE_BATCH_SIZE` rows; a larger backlog drains over the following runs (cron
 *   every minute). No per-org loop, no "delete until empty" loop. `vault_admin` holds only
 *   `SELECT (org_id, jti, expires_at)` + `DELETE` on the table (migration 0103).
 * - Only rows with `expires_at < now - DELEGATION_JTI_PRUNE_GRACE_SECONDS` are deleted. The grace
 *   absorbs clock drift between the instance that burned a row (it wrote `exp + 30 s`) and the
 *   instance that prunes it, so a row is never removed while any verifier could still accept its
 *   assertion (invariant I1). Pruning lag never affects correctness; rows only reclaim storage.
 * - Logs only `runPruneJob`'s count line, plus one `job.backlog` line when a run deletes a full
 *   batch. Never a jti, kid or org id.
 */
export const DELEGATION_JTI_PRUNE_JOB = 'delegation/prune-assertion-jti'
export const DELEGATION_JTI_PRUNE_BATCH_SIZE = 5000
export const DELEGATION_JTI_PRUNE_GRACE_SECONDS = 300

export function delegationJtiPruneCutoff(now: Date): Date {
  return new Date(now.getTime() - DELEGATION_JTI_PRUNE_GRACE_SECONDS * 1000)
}

export type DelegationJtiPrunerDeps = {
  now?: () => Date
  batchSize?: number
  getDb?: typeof getAdminDb
}

export type DelegationJtiPruner = {
  prune: (logger?: WorkerLogger) => Promise<void>
}

export function createDelegationJtiPruner(deps: DelegationJtiPrunerDeps = {}): DelegationJtiPruner {
  const now = deps.now ?? (() => new Date())
  const batchSize = deps.batchSize ?? DELEGATION_JTI_PRUNE_BATCH_SIZE
  const getDb = deps.getDb ?? getAdminDb

  async function prune(logger: WorkerLogger = defaultWorkerLogger): Promise<void> {
    let deletedCount = 0
    await runPruneJob(
      DELEGATION_JTI_PRUNE_JOB,
      async () => {
        const db = getDb()
        const oldestExpired = db
          .select({ orgId: delegationAssertionJti.orgId, jti: delegationAssertionJti.jti })
          .from(delegationAssertionJti)
          .where(lt(delegationAssertionJti.expiresAt, delegationJtiPruneCutoff(now())))
          .orderBy(asc(delegationAssertionJti.expiresAt))
          .limit(batchSize)
        const deleted = await db
          .delete(delegationAssertionJti)
          .where(
            inArray(
              sql`(${delegationAssertionJti.orgId}, ${delegationAssertionJti.jti})`,
              oldestExpired
            )
          )
          .returning({ expiresAt: delegationAssertionJti.expiresAt })
        deletedCount = deleted.length
        return deleted
      },
      logger
    )
    if (deletedCount === batchSize) {
      logger.info({ eventType: 'job.backlog', jobName: DELEGATION_JTI_PRUNE_JOB, batchSize })
    }
  }

  return { prune }
}

const defaultPruner = createDelegationJtiPruner()

/** The production prune: real clock, admin pool, fixed batch size. */
export function pruneDelegationAssertionJti(logger?: WorkerLogger): Promise<void> {
  return defaultPruner.prune(logger)
}
