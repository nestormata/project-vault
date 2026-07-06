import { and, eq, inArray, lt, sql } from 'drizzle-orm'
import { OperationalEvent } from '@project-vault/shared'
import type { Tx } from '@project-vault/db'
import { rotationChecklistItems, rotations } from '@project-vault/db/schema'
import { env } from '../config/env.js'
import { fetchAllOrgIds, runOrgScopedJob } from '../middleware/rls.js'
import { tryAcquireRotationScopedLock } from '../lib/rotation-locks.js'
import { writeSystemAuditRow } from '../lib/system-audit-row.js'
import { operationalLog, serializeLogError } from '../lib/logger.js'
import {
  dispatchDirectUserNotification,
  enqueueSecurityAlertNotification,
  sendNotificationJobs,
  type NotificationQueueJob,
} from '../notifications/dispatcher.js'
import type { BossService } from '../lib/boss.js'
import { rotationStaleDetectionsTotal } from '../modules/rotation/metrics.js'
import type { WorkerLogger } from './expiry-alert-shared.js'

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
  candidate: StaleRotationRow,
  logger?: WorkerLogger
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

    await writeSystemAuditRow(tx, {
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
    } else if (logger) {
      // Story 5.5 AC-5: `initiatedBy` is nullable (`onDelete: 'set null'`) — the initiating
      // user's account was deleted before this rotation went stale. Skip (never throw) the
      // direct-user notification; the org-wide FR100-routed alert below still fires.
      operationalLog(
        logger,
        'info',
        OperationalEvent.ROTATION_STALE_DETECTED,
        'Skipping direct-user stale-rotation notification — initiating user no longer exists',
        { orgId, rotationId: candidate.id }
      )
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

async function recoverStaleRotationsForOrg(
  orgId: string,
  boss: BossService,
  logger?: WorkerLogger
): Promise<void> {
  const candidates = await runOrgScopedJob(orgId, JOB_NAME, ({ tx }) =>
    findStaleRotations(tx, orgId)
  )
  for (const candidate of candidates) {
    // Story 5.5 AC-9: recoverOneRotation() already runs each candidate in its OWN transaction
    // (via runOrgScopedJob), so an audit-write (or any other) failure inside it already rolls
    // back only that one row's state transition — but without this try/catch, the thrown error
    // would still propagate out of this loop and abort every other candidate (in this org AND
    // every other org still to come in the same job run). Catching here, logging, and moving on
    // is what actually makes "a single row's failure never aborts the entire job run" true.
    try {
      const jobs = await recoverOneRotation(orgId, candidate, logger)
      if (jobs && jobs.length > 0) {
        await sendNotificationJobs(boss, jobs)
      }
    } catch (error) {
      if (logger) {
        operationalLog(
          logger,
          'error',
          OperationalEvent.ROTATION_STALE_DETECTION_ROW_FAILED,
          'Stale-rotation recovery failed for one candidate — skipping and continuing',
          { orgId, rotationId: candidate.id, err: serializeLogError(error) }
        )
      }
    }
  }
}

/** `rotation:recover` (AC-9/AC-10) — pg-boss job, registered both as a 15-minute recurring cron
 *  AND enqueued once at every API startup (deduplicated via singletonKey). Time-threshold scan
 *  (CR2/ADR-5.3-02) — never lock-presence detection, since 5.1's advisory lock is
 *  transaction-scoped and releases the instant initiation commits; there is no lock left to
 *  check by the time a rotation is stale. Never auto-resolves (AC-E5d) — only ever transitions
 *  in_progress -> stale_recovery, leaving resume/abandon to a human decision. */
export async function runStaleRotationRecoveryJob(
  boss: BossService,
  logger?: WorkerLogger
): Promise<void> {
  const orgIds = await fetchAllOrgIds()
  for (const orgId of orgIds) {
    // Story 5.5 AC-9: same rationale as the per-candidate try/catch above, one level up — an
    // unexpected failure scanning/processing one org (not just a single candidate row within it)
    // must not prevent every other org from being processed in the same run.
    try {
      await recoverStaleRotationsForOrg(orgId, boss, logger)
    } catch (error) {
      if (logger) {
        operationalLog(
          logger,
          'error',
          OperationalEvent.ROTATION_STALE_DETECTION_ROW_FAILED,
          'Stale-rotation recovery failed for one org — skipping and continuing',
          { orgId, err: serializeLogError(error) }
        )
      }
    }
  }
}
