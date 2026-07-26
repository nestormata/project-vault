import { and, eq, lt, type SQL } from 'drizzle-orm'
import type { NotificationSeverity } from '@project-vault/shared'
import { OperationalEvent } from '@project-vault/shared'
import type { Tx } from '@project-vault/db'
import { rotations } from '@project-vault/db/schema'
import { operationalLog } from '../lib/logger.js'
import { tryAcquireRotationScopedLock } from '../lib/rotation-locks.js'
import { runOrgScopedJob } from '../middleware/rls.js'
import {
  dispatchDirectUserNotification,
  enqueueSecurityAlertNotification,
  type NotificationQueueJob,
} from '../notifications/dispatcher.js'
import type { WorkerLogger } from './expiry-alert-shared.js'

/** Shared by rotation-recover.ts and rotation-stale-staged-alert.ts's per-candidate processing:
 *  both open the candidate's own org-scoped transaction, take the rotation-scoped advisory lock
 *  (same key domain as every human rotation mutation, so this can never race a concurrent human
 *  action on the same rotation), and silently skip (return null, never throw) if the lock is
 *  currently held — a human action is mid-flight. */
export async function withRotationScopedLock<T>(
  orgId: string,
  jobName: string,
  candidateId: string,
  fn: (tx: Tx) => Promise<T | null>
): Promise<T | null> {
  return runOrgScopedJob(orgId, jobName, async ({ tx }) => {
    const locked = await tryAcquireRotationScopedLock(tx, orgId, candidateId)
    if (!locked) return null
    return fn(tx)
  })
}

export type RotationAlertCandidate = {
  id: string
  credentialId: string
  initiatedBy: string | null
}

/** Shared by rotation-recover.ts's stale-detection scan and rotation-stale-staged-alert.ts's
 *  stale-staged scan: both select the same `{id, credentialId, initiatedBy}` candidate shape,
 *  filtered to a specific `status` and `initiated_at` older than a threshold — differing only in
 *  the status value/threshold scale and (for the stale-staged job) one extra guard condition. */
export async function findRotationCandidates(
  tx: Tx,
  orgId: string,
  status: string,
  threshold: Date,
  extraCondition?: SQL
): Promise<RotationAlertCandidate[]> {
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
        eq(rotations.status, status),
        lt(rotations.initiatedAt, threshold),
        ...(extraCondition ? [extraCondition] : [])
      )
    )
}

/** Shared by rotation-recover.ts's stale-detection job and rotation-stale-staged-alert.ts's
 *  stale-staged job: both dispatch an identical shape of notification — a direct-user alert to
 *  the rotation's initiator (skipped, never thrown, if that user's account has since been
 *  deleted — `initiatedBy` is nullable, `onDelete: 'set null'`) plus an FR100-routed org-wide
 *  security alert. Split out so the two wholly-separate workers (ADR-5.6-04) don't duplicate this
 *  dispatch logic verbatim. */
export async function dispatchRotationAlertNotifications(params: {
  orgId: string
  candidate: RotationAlertCandidate
  tx: Tx
  templateId: string
  severity: NotificationSeverity
  payload: Record<string, unknown>
  logger?: WorkerLogger
}): Promise<NotificationQueueJob[]> {
  const jobs: NotificationQueueJob[] = []
  if (params.candidate.initiatedBy) {
    const directJobs = await dispatchDirectUserNotification({
      orgId: params.orgId,
      userId: params.candidate.initiatedBy,
      template: {
        templateId: params.templateId,
        payload: params.payload,
        severity: params.severity,
      },
      tx: params.tx,
    })
    jobs.push(...directJobs)
  } else if (params.logger) {
    operationalLog(
      params.logger,
      'info',
      OperationalEvent.ROTATION_STALE_DETECTED,
      'Skipping direct-user rotation notification — initiating user no longer exists',
      { orgId: params.orgId, rotationId: params.candidate.id }
    )
  }
  const routedJobs = await enqueueSecurityAlertNotification({
    orgId: params.orgId,
    templateId: params.templateId,
    payload: params.payload,
    severity: params.severity,
    tx: params.tx,
  })
  jobs.push(...routedJobs)
  return jobs
}
