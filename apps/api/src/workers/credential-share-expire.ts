import { and, eq, lt } from 'drizzle-orm'
import { OperationalEvent } from '@project-vault/shared'
import type { Tx } from '@project-vault/db'
import { credentialShares } from '@project-vault/db/schema'
import { fetchAllOrgIds, runOrgScopedJob } from '../middleware/rls.js'
import { operationalLog, serializeLogError } from '../lib/logger.js'
import { credentialShareExpirySweepTotal } from '../modules/credential-shares/metrics.js'
import { lazilyExpireShareIfDue } from '../modules/credential-shares/service.js'
import type { WorkerLogger } from './expiry-alert-shared.js'

const JOB_NAME = 'credential-shares/expire'

/** Story 17.3 AC-7/AC-8: closes the "nobody ever opens the link again" gap the lazy check alone
 *  leaves open — Share History (AC-1/AC-2) must show an accurate, up-to-date status for shares
 *  that are never re-accessed by anyone. Org-wide scan (RLS-scoped per org, same shape as
 *  rotation-recover.ts's `findStaleRotations`), `WHERE status = 'active' AND expires_at < now()`.
 */
async function findDueCandidates(
  tx: Tx,
  orgId: string
): Promise<{ id: string; expiresAt: Date }[]> {
  return tx
    .select({ id: credentialShares.id, expiresAt: credentialShares.expiresAt })
    .from(credentialShares)
    .where(
      and(
        eq(credentialShares.orgId, orgId),
        eq(credentialShares.status, 'active'),
        lt(credentialShares.expiresAt, new Date())
      )
    )
}

/** AC-7: per-candidate-transaction pattern (5.6's rotation-recover.ts/rotation-stale-staged-
 *  alert.ts precedent) — one transaction per row, never a single transaction spanning multiple
 *  rows, so a worker crash mid-batch leaves already-processed rows fully transitioned+audited and
 *  not-yet-processed rows fully untouched. No advisory lock is needed here (unlike the rotation
 *  workers, which coordinate with in-flight human checklist actions): the underlying transition
 *  is already a `WHERE status = 'active'` CAS — a concurrent lazy-check reveal/metadata-GET
 *  request racing this sweep on the same row is resolved by whichever write wins the CAS, and
 *  `lazilyExpireShareIfDue` is a safe no-op (no double transition, no double audit row) for the
 *  loser either way. */
async function expireOneShare(
  orgId: string,
  candidateId: string,
  logger?: WorkerLogger
): Promise<boolean> {
  return runOrgScopedJob(orgId, JOB_NAME, async ({ tx }) => {
    const [row] = await tx
      .select()
      .from(credentialShares)
      .where(eq(credentialShares.id, candidateId))
      .limit(1)
    // Not `active` anymore (revoked/viewed/expired/superseded by a concurrent request between
    // this candidate scan and this transaction opening) — nothing for this worker to do; AC-5's
    // guard ("the transition only applies to shares still active at the moment expiry is
    // discovered") applies here exactly as it does to the lazy-check path.
    if (!row || row.status !== 'active') return false
    const updated = await lazilyExpireShareIfDue(tx, row)
    // `lazilyExpireShareIfDue` returns the pre-transition `share` object unchanged (status still
    // reads 'active') when it loses the CAS race — only a `status === 'expired'` result here
    // means THIS transaction's write actually won and the audit entry was actually written.
    return updated.status === 'expired'
  }).catch((error) => {
    if (logger) {
      operationalLog(
        logger,
        'error',
        OperationalEvent.CREDENTIAL_SHARE_EXPIRE_SWEEP_ROW_FAILED,
        'Credential-share expiry sweep failed for one candidate — skipping and continuing',
        { orgId, shareId: candidateId, err: serializeLogError(error) }
      )
    }
    return false
  })
}

async function sweepOrg(orgId: string, logger?: WorkerLogger): Promise<void> {
  const candidates = await runOrgScopedJob(orgId, JOB_NAME, ({ tx }) =>
    findDueCandidates(tx, orgId)
  )
  for (const candidate of candidates) {
    const expired = await expireOneShare(orgId, candidate.id, logger)
    if (expired) credentialShareExpirySweepTotal.inc()
  }
}

/** `credential-shares/expire` (AC-7) — pg-boss job, registered on an hourly cron
 *  (apps/api/src/main.ts). Recommended cadence documented in the Dev Agent Record: hourly, not
 *  5.6's daily stale-staged cadence, because share `expiresAt` windows in this epic are measured
 *  in hours (17.1 default 24h/cap 7d, 17.2 default 1h/cap 72h) — a daily sweep would leave a
 *  share showing stale `active` status in Share History for up to 24h after it actually expired.
 */
export async function runCredentialShareExpireJob(logger?: WorkerLogger): Promise<void> {
  const orgIds = await fetchAllOrgIds()
  for (const orgId of orgIds) {
    try {
      await sweepOrg(orgId, logger)
    } catch (error) {
      if (logger) {
        operationalLog(
          logger,
          'error',
          OperationalEvent.CREDENTIAL_SHARE_EXPIRE_SWEEP_ROW_FAILED,
          'Credential-share expiry sweep failed for one org — skipping and continuing',
          { orgId, err: serializeLogError(error) }
        )
      }
    }
  }
}
