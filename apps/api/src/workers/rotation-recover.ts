import { and, eq, inArray, lt, sql } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import { rotationChecklistItems, rotations } from '@project-vault/db/schema'
import { env } from '../config/env.js'
import { fetchAllOrgIds, runOrgScopedJob } from '../middleware/rls.js'
import { tryAcquireRotationScopedLock } from '../lib/rotation-locks.js'
import { writeSystemActorAuditRow } from '../lib/system-actor-audit.js'
import {
  dispatchDirectUserNotification,
  enqueueSecurityAlertNotification,
  sendNotificationJobs,
  type NotificationQueueJob,
} from '../notifications/dispatcher.js'
import type { BossService } from '../lib/boss.js'
import { rotationStaleDetectionsTotal } from '../modules/rotation/metrics.js'

const EVENT_TYPE = 'rotation.stale_detected'
const JOB_NAME = 'rotation:recover'
// AC-9: non-confirmed statuses reset to 'unconfirmed' — 'unconfirmed' is included for symmetry
// with the literal AC-9 WHERE clause (a no-op for already-unconfirmed rows); 'confirmed' items
// are deliberately excluded and left untouched.
const RESETTABLE_STATUSES = ['unconfirmed', 'failed', 'max_retries_exceeded'] as const

type StaleRotationRow = { id: string; credentialId: string; initiatedBy: string | null }

/** AC-9 step 1: org-wide (not credential-scoped), uses idx_rotations_status_initiated. */
async function findStaleRotations(tx: Tx, orgId: string): Promise<StaleRotationRow[]> {
  const threshold = new Date(Date.now() - env.STALE_ROTATION_THRESHOLD_MINUTES * 60_000)
  return tx
    .select({
      id: rotations.id,
      credentialId: rotations.credentialId,
      initiatedBy: rotations.initiatedBy,
    })
    .from(rotations)
    .where(
      and(
        eq(rotations.orgId, orgId),
        eq(rotations.status, 'in_progress'),
        lt(rotations.initiatedAt, threshold)
      )
    )
}

/** AC-9/AC-10, one transaction per candidate rotation. Returns the notification jobs to dispatch
 *  post-commit (best-effort), or null if this rotation was skipped (lock contention or a
 *  concurrent transition already moved it out of in_progress). Step 2's lock is rotation-scoped
 *  — same key domain as 5.2's confirm/fail/retry/complete, so this job can never race a
 *  concurrent human action on the same rotation. */
async function recoverOneRotation(
  orgId: string,
  candidate: StaleRotationRow
): Promise<NotificationQueueJob[] | null> {
  return runOrgScopedJob(orgId, JOB_NAME, async ({ tx }) => {
    const locked = await tryAcquireRotationScopedLock(tx, orgId, candidate.id)
    if (!locked) return null // silent skip — a human confirm/fail/retry/complete call is mid-flight

    const [updated] = await tx
      .update(rotations)
      .set({
        status: 'stale_recovery',
        version: sql`${rotations.version} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(rotations.id, candidate.id), eq(rotations.status, 'in_progress')))
      .returning({ id: rotations.id })
    if (!updated) return null // re-checked inside the lock — already transitioned by something else

    const resetItems = await tx
      .update(rotationChecklistItems)
      .set({ status: 'unconfirmed', updatedAt: new Date() })
      .where(
        and(
          eq(rotationChecklistItems.rotationId, candidate.id),
          inArray(rotationChecklistItems.status, RESETTABLE_STATUSES)
        )
      )
      .returning({ id: rotationChecklistItems.id })

    await writeSystemActorAuditRow(tx, {
      orgId,
      eventType: EVENT_TYPE,
      payload: {
        credentialId: candidate.credentialId,
        initiatedBy: candidate.initiatedBy,
        thresholdMinutes: env.STALE_ROTATION_THRESHOLD_MINUTES,
        pendingItemsReset: resetItems.length,
      },
    })
    rotationStaleDetectionsTotal.inc()

    const jobs: NotificationQueueJob[] = []
    if (candidate.initiatedBy) {
      const directJobs = await dispatchDirectUserNotification({
        orgId,
        userId: candidate.initiatedBy,
        template: {
          templateId: 'rotation.stale',
          payload: { rotationId: candidate.id, credentialId: candidate.credentialId },
          severity: 'warning',
        },
        tx,
      })
      jobs.push(...directJobs)
    }
    const routedJobs = await enqueueSecurityAlertNotification({
      orgId,
      templateId: 'rotation.stale',
      payload: { rotationId: candidate.id, credentialId: candidate.credentialId },
      severity: 'warning',
      tx,
    })
    jobs.push(...routedJobs)

    return jobs
  })
}

async function recoverStaleRotationsForOrg(orgId: string, boss: BossService): Promise<void> {
  const candidates = await runOrgScopedJob(orgId, JOB_NAME, ({ tx }) =>
    findStaleRotations(tx, orgId)
  )
  for (const candidate of candidates) {
    const jobs = await recoverOneRotation(orgId, candidate)
    if (jobs && jobs.length > 0) {
      await sendNotificationJobs(boss, jobs)
    }
  }
}

/** `rotation:recover` (AC-9/AC-10) — pg-boss job, registered both as a 15-minute recurring cron
 *  AND enqueued once at every API startup (deduplicated via singletonKey). Time-threshold scan
 *  (CR2/ADR-5.3-02) — never lock-presence detection, since 5.1's advisory lock is
 *  transaction-scoped and releases the instant initiation commits; there is no lock left to
 *  check by the time a rotation is stale. Never auto-resolves (AC-E5d) — only ever transitions
 *  in_progress -> stale_recovery, leaving resume/abandon to a human decision. */
export async function runStaleRotationRecoveryJob(boss: BossService): Promise<void> {
  const orgIds = await fetchAllOrgIds()
  for (const orgId of orgIds) {
    await recoverStaleRotationsForOrg(orgId, boss)
  }
}
