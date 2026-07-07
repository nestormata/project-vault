import { and, eq, isNotNull, lte } from 'drizzle-orm'
import { OperationalEvent } from '@project-vault/shared'
import type { Tx } from '@project-vault/db'
import { credentialVersions } from '@project-vault/db/schema'
import { fetchAllOrgIds, runOrgScopedJob } from '../middleware/rls.js'
import { tryAcquireCredentialScopedLock } from '../lib/rotation-locks.js'
import { writeSystemAuditRow } from '../lib/system-audit-row.js'
import { operationalLog, serializeLogError } from '../lib/logger.js'
import { rotationBreakGlassOverlapExpirationsTotal } from '../modules/rotation/metrics.js'
import type { WorkerLogger } from './expiry-alert-shared.js'

const EVENT_TYPE = 'rotation.break_glass_overlap_expired'
const JOB_NAME = 'rotation/break-glass-expire'

type ExpiredVersionRow = { id: string; credentialId: string }

/** AC-8 step 1: org-scoped scan for versions whose break-glass overlap window has passed. */
async function findExpiredOverlapVersions(tx: Tx, orgId: string): Promise<ExpiredVersionRow[]> {
  return tx
    .select({ id: credentialVersions.id, credentialId: credentialVersions.credentialId })
    .from(credentialVersions)
    .where(
      and(
        eq(credentialVersions.orgId, orgId),
        isNotNull(credentialVersions.breakGlassOverlapExpiresAt),
        lte(credentialVersions.breakGlassOverlapExpiresAt, new Date())
      )
    )
}

/** AC-8 steps 2-3, one short transaction per candidate row (same batching rationale as
 *  prune-credential-versions.ts) — the WHERE re-check on the UPDATE is the CAS-equivalent: if
 *  the row's overlap window was extended or cleared between the scan and this write, this is a
 *  safe no-op (edge case: BREAK_GLASS_OVERLAP_MINUTES lowered after the fact never retroactively
 *  applies — the already-stored absolute timestamp is honored as-is). Step 2's lock reuses the
 *  same credential-scoped key as break-glass itself (AC-2/AC-6), so a concurrent break-glass call
 *  on the same credential can never race the expiry job mid-transition. */
async function expireOneVersion(orgId: string, candidate: ExpiredVersionRow): Promise<void> {
  await runOrgScopedJob(orgId, JOB_NAME, async ({ tx }) => {
    const locked = await tryAcquireCredentialScopedLock(tx, orgId, candidate.credentialId)
    if (!locked) return // silent skip — a concurrent break-glass call holds this credential's lock

    const [updated] = await tx
      .update(credentialVersions)
      .set({ rotationLockedAt: null, breakGlassOverlapExpiresAt: null })
      .where(
        and(
          eq(credentialVersions.id, candidate.id),
          lte(credentialVersions.breakGlassOverlapExpiresAt, new Date())
        )
      )
      .returning({ id: credentialVersions.id })
    if (!updated) return

    await writeSystemAuditRow(tx, {
      orgId,
      eventType: EVENT_TYPE,
      payload: { credentialVersionId: candidate.id, credentialId: candidate.credentialId },
    })
    rotationBreakGlassOverlapExpirationsTotal.inc()
  })
}

async function expireOverlapForOrg(orgId: string, logger?: WorkerLogger): Promise<void> {
  const candidates = await runOrgScopedJob(orgId, JOB_NAME, ({ tx }) =>
    findExpiredOverlapVersions(tx, orgId)
  )
  for (const candidate of candidates) {
    // Story 5.5 AC-9: same rationale as rotation-recover.ts's identical try/catch — each
    // candidate already runs in its own transaction (runOrgScopedJob), so a thrown error here
    // already rolls back only that one row; without this catch, though, the throw would still
    // propagate out of this loop and abort every other candidate/org left in the same run.
    try {
      await expireOneVersion(orgId, candidate)
    } catch (error) {
      if (logger) {
        operationalLog(
          logger,
          'error',
          OperationalEvent.ROTATION_BREAK_GLASS_EXPIRE_ROW_FAILED,
          'Break-glass overlap expiry failed for one candidate — skipping and continuing',
          { orgId, credentialVersionId: candidate.id, err: serializeLogError(error) }
        )
      }
    }
  }
}

/** `rotation/break-glass-expire` (AC-8) — pg-boss job, cron `* * * * *` (every minute, matching
 *  security/check-failed-auth-threshold's cadence). No vault-seal gating: this is backend-worker
 *  bookkeeping (rotationLockedAt/breakGlassOverlapExpiresAt), no plaintext is touched. */
export async function runBreakGlassOverlapExpiryJob(logger?: WorkerLogger): Promise<void> {
  const orgIds = await fetchAllOrgIds()
  for (const orgId of orgIds) {
    // Story 5.5 AC-9: org-level equivalent of the per-candidate catch above.
    try {
      await expireOverlapForOrg(orgId, logger)
    } catch (error) {
      if (logger) {
        operationalLog(
          logger,
          'error',
          OperationalEvent.ROTATION_BREAK_GLASS_EXPIRE_ROW_FAILED,
          'Break-glass overlap expiry failed for one org — skipping and continuing',
          { orgId, err: serializeLogError(error) }
        )
      }
    }
  }
}
