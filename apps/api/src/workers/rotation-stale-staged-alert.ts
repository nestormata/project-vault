import { and, eq, isNull } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import type { BossService } from '../lib/boss.js'
import { AuditEvent, OperationalEvent } from '@project-vault/shared'
import { rotations } from '@project-vault/db/schema'
import { fetchAllOrgIds, runOrgScopedJob } from '../middleware/rls.js'
import { env } from '../config/env.js'
import { operationalLog, serializeLogError } from '../lib/logger.js'
import { writeSystemAuditRow } from '../lib/system-audit-row.js'
import { rotationStaleStagedAlertsTotal } from '../modules/rotation/metrics.js'
import { sendNotificationJobs, type NotificationQueueJob } from '../notifications/dispatcher.js'
import {
  dispatchRotationAlertNotifications,
  findRotationCandidates,
  withRotationScopedLock,
  type RotationAlertCandidate,
} from './rotation-notify-shared.js'
import type { WorkerLogger } from './expiry-alert-shared.js'

const JOB_NAME = 'rotation/stale-staged-alert'

// Story 5.6 AC-4.2: this job NEVER transitions `status`. It is purely informational — the literal
// distinction from rotation-recover.ts (which DOES transition status) is the single most
// load-bearing fact about this file. Do not add a status UPDATE here.
type StaleStagedRotationRow = RotationAlertCandidate

/** AC-4.1/AC-4.3: org-wide scan for staged rotations older than the (day-scale, wholly separate)
 *  threshold that have never been alerted before. */
async function findStaleStagedRotations(tx: Tx, orgId: string): Promise<StaleStagedRotationRow[]> {
  const thresholdMs = env.STALE_STAGED_ROTATION_THRESHOLD_DAYS * 24 * 60 * 60 * 1000
  const threshold = new Date(Date.now() - thresholdMs)
  return findRotationCandidates(
    tx,
    orgId,
    'staged',
    threshold,
    isNull(rotations.staleStagedAlertedAt)
  )
}

/** AC-4.3/Task 4: one transaction per candidate row (lock -> check -> alert -> set
 *  stale_staged_alerted_at -> audit), matching rotation-recover.ts's established per-candidate
 *  transaction pattern exactly — a worker crash mid-batch leaves already-processed rows fully
 *  alerted+audited and not-yet-processed rows fully untouched. */
async function alertOneRotation(
  orgId: string,
  candidate: StaleStagedRotationRow,
  logger?: WorkerLogger
): Promise<NotificationQueueJob[] | null> {
  return withRotationScopedLock(orgId, JOB_NAME, candidate.id, async (tx) => {
    const [updated] = await tx
      .update(rotations)
      .set({ staleStagedAlertedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(rotations.id, candidate.id),
          eq(rotations.status, 'staged'),
          isNull(rotations.staleStagedAlertedAt)
        )
      )
      .returning({ id: rotations.id })
    if (!updated) return null // re-checked inside the lock — already alerted or transitioned

    await writeSystemAuditRow(tx, {
      orgId,
      eventType: AuditEvent.ROTATION_STALE_STAGED_DETECTED,
      payload: {
        rotationId: candidate.id,
        credentialId: candidate.credentialId,
        initiatedBy: candidate.initiatedBy,
        thresholdDays: env.STALE_STAGED_ROTATION_THRESHOLD_DAYS,
      },
    })
    rotationStaleStagedAlertsTotal.inc()

    // Same nullable-initiatedBy edge case as rotation-recover.ts, handled by the shared dispatch
    // helper (also used there).
    const jobs = await dispatchRotationAlertNotifications({
      orgId,
      candidate,
      tx,
      templateId: 'rotation.stale_staged',
      severity: 'warning',
      payload: { rotationId: candidate.id, credentialId: candidate.credentialId },
      logger,
    })

    return jobs
  })
}

async function alertStaleStagedForOrg(
  orgId: string,
  boss: BossService,
  logger?: WorkerLogger
): Promise<void> {
  const candidates = await runOrgScopedJob(orgId, JOB_NAME, ({ tx }) =>
    findStaleStagedRotations(tx, orgId)
  )
  for (const candidate of candidates) {
    // Same isolation rationale as rotation-recover.ts: each candidate already runs in its own
    // transaction, so a thrown error here only rolls back that one row — this catch stops it
    // from also aborting every other candidate/org left in the same run.
    try {
      const jobs = await alertOneRotation(orgId, candidate, logger)
      if (jobs && jobs.length > 0) {
        await sendNotificationJobs(boss, jobs)
      }
    } catch (error) {
      if (logger) {
        operationalLog(
          logger,
          'error',
          OperationalEvent.ROTATION_STALE_STAGED_ALERT_ROW_FAILED,
          'Stale-staged alert failed for one candidate — skipping and continuing',
          { orgId, rotationId: candidate.id, err: serializeLogError(error) }
        )
      }
    }
  }
}

/** `rotation/stale-staged-alert` (AC-4) — pg-boss job, wholly separate worker/env-var/column/
 *  audit-event from rotation-recover.ts's 1h in_progress -> stale_recovery job (ADR-5.6-04). Only
 *  ever alerts (writes an audit row + notification + `stale_staged_alerted_at`) — never mutates
 *  `status`, never abandons, never touches the crash-recovery flow in any way. */
export async function runStaleStagedAlertJob(
  boss: BossService,
  logger?: WorkerLogger
): Promise<void> {
  const orgIds = await fetchAllOrgIds()
  for (const orgId of orgIds) {
    try {
      await alertStaleStagedForOrg(orgId, boss, logger)
    } catch (error) {
      if (logger) {
        operationalLog(
          logger,
          'error',
          OperationalEvent.ROTATION_STALE_STAGED_ALERT_ROW_FAILED,
          'Stale-staged alert failed for one org — skipping and continuing',
          { orgId, err: serializeLogError(error) }
        )
      }
    }
  }
}
