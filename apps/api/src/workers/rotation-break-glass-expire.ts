import { and, eq, isNotNull, lte } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import { credentialVersions } from '@project-vault/db/schema'
import { fetchAllOrgIds, runOrgScopedJob } from '../middleware/rls.js'
import { tryAcquireCredentialScopedLock } from '../lib/rotation-locks.js'
import { writeSystemActorAuditRow } from '../lib/system-actor-audit.js'
import { rotationBreakGlassOverlapExpirationsTotal } from '../modules/rotation/metrics.js'

const EVENT_TYPE = 'rotation.break_glass_overlap_expired'
const JOB_NAME = 'rotation:break-glass-expire'

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

    await writeSystemActorAuditRow(tx, {
      orgId,
      eventType: EVENT_TYPE,
      payload: { credentialVersionId: candidate.id, credentialId: candidate.credentialId },
    })
    rotationBreakGlassOverlapExpirationsTotal.inc()
  })
}

async function expireOverlapForOrg(orgId: string): Promise<void> {
  const candidates = await runOrgScopedJob(orgId, JOB_NAME, ({ tx }) =>
    findExpiredOverlapVersions(tx, orgId)
  )
  for (const candidate of candidates) {
    await expireOneVersion(orgId, candidate)
  }
}

/** `rotation:break-glass-expire` (AC-8) — pg-boss job, cron `* * * * *` (every minute, matching
 *  security/check-failed-auth-threshold's cadence). No vault-seal gating: this is backend-worker
 *  bookkeeping (rotationLockedAt/breakGlassOverlapExpiresAt), no plaintext is touched. */
export async function runBreakGlassOverlapExpiryJob(): Promise<void> {
  const orgIds = await fetchAllOrgIds()
  for (const orgId of orgIds) {
    await expireOverlapForOrg(orgId)
  }
}
