import { and, eq, gt, isNull, lte } from 'drizzle-orm'
import { AuditEvent, OperationalEvent } from '@project-vault/shared'
import { apiKeys, machineUsers } from '@project-vault/db/schema'
import type { BossService } from '../lib/boss.js'
import { fetchAllOrgIds, runOrgScopedJob } from '../middleware/rls.js'
import { writeSystemAuditEntryOrFailClosed } from '../lib/audit-or-fail-closed.js'
import {
  createOrgAdminNotificationEntries,
  sendNotificationJobs,
  type NotificationQueueJob,
} from '../notifications/dispatcher.js'
import { operationalLog, serializeLogError } from '../lib/logger.js'
import type { WorkerLogger } from './expiry-alert-shared.js'

const REVOKE_JOB_NAME = 'machine-key:overlap-revoke'
const ALERT_JOB_NAME = 'machine-key:overlap-alert'
const ONE_HOUR_MS = 3_600_000

function logRowFailure(
  logger: WorkerLogger | undefined,
  orgId: string,
  assetId: string,
  error: unknown
): void {
  if (!logger) return
  operationalLog(
    logger,
    'error',
    OperationalEvent.MONITORING_EXPIRY_ALERT_ROW_FAILED,
    'machine key overlap job row failed',
    { orgId, assetId, err: serializeLogError(error) }
  )
}

function logOrgFailure(logger: WorkerLogger | undefined, orgId: string, error: unknown): void {
  if (!logger) return
  operationalLog(
    logger,
    'error',
    OperationalEvent.MONITORING_EXPIRY_ALERT_ROW_FAILED,
    'machine key overlap job org fetch failed',
    { orgId, assetId: 'n/a', err: serializeLogError(error) }
  )
}

/**
 * Story 7.2 AC-18 — 5-minute cadence: revokes any key whose overlap window has passed.
 * AC-17 permits `overlapMinutes` as low as 1, so a coarser cadence (e.g. hourly) could leave such
 * a key valid up to ~59 minutes past its configured expiry purely from cron granularity — the
 * 5-minute cadence bounds that overshoot regardless of how short an overlap window was chosen.
 * The UPDATE and the system-actor audit write happen in one job-internal transaction so a failed
 * audit write rolls back that row's revocation too, to be retried on the next 5-minute run
 * (AC-24) — failure isolation follows expiry-alert-shared.ts's per-org/per-row try/catch pattern,
 * not `runExpiryAlertJob()` itself (this isn't a lead-days-threshold shape).
 */
export async function runMachineKeyOverlapRevokeJob(logger?: WorkerLogger): Promise<void> {
  const now = new Date()
  const orgIds = await fetchAllOrgIds()

  for (const orgId of orgIds) {
    try {
      const rows = await runOrgScopedJob(orgId, REVOKE_JOB_NAME, ({ tx }) =>
        tx
          .select({ id: apiKeys.id })
          .from(apiKeys)
          .where(and(lte(apiKeys.overlapExpiresAt, now), isNull(apiKeys.revokedAt)))
      )

      for (const row of rows) {
        try {
          await runOrgScopedJob(orgId, REVOKE_JOB_NAME, async ({ tx }) => {
            // AC-18: idempotent — mirrors 7.1's own revoke-endpoint pattern (conditional UPDATE
            // gated on revokedAt IS NULL) in case a human admin races a manual revoke against
            // this job for the same key; the loser's WHERE simply matches 0 rows.
            const [claimed] = await tx
              .update(apiKeys)
              .set({ revokedAt: now })
              .where(and(eq(apiKeys.id, row.id), isNull(apiKeys.revokedAt)))
              .returning({ id: apiKeys.id })
            if (!claimed) return

            await writeSystemAuditEntryOrFailClosed(tx, {
              orgId,
              eventType: AuditEvent.MACHINE_USER_API_KEY_REVOKED,
              resourceType: 'api_key',
              resourceId: row.id,
              payload: { reason: 'overlap_window_expired', oldKeyId: row.id },
            })
          })
        } catch (error) {
          logRowFailure(logger, orgId, row.id, error)
        }
      }
    } catch (error) {
      logOrgFailure(logger, orgId, error)
    }
  }
}

/**
 * Story 7.2 AC-18 — hourly cadence: fires a pre-revocation alert exactly once per key, ~1 hour
 * before its overlap window ends, reusing the same `machine_key.expiry` template 7.1 already
 * established (not a fourth near-duplicate alert type) — `reason: 'rotation_overlap_ending'`
 * differentiates it from 7.1's own `reason: 'natural_expiry'` use of the same template.
 * `overlap_alert_sent` is the dedupe flag (a simple boolean, not a lead-days array, since there's
 * only one threshold here).
 */
export async function runMachineKeyOverlapAlertJob(
  boss: BossService,
  logger?: WorkerLogger
): Promise<void> {
  const now = new Date()
  const soon = new Date(now.getTime() + ONE_HOUR_MS)
  const orgIds = await fetchAllOrgIds()
  const allJobs: NotificationQueueJob[] = []

  for (const orgId of orgIds) {
    try {
      const rows = await runOrgScopedJob(orgId, ALERT_JOB_NAME, ({ tx }) =>
        tx
          .select({
            id: apiKeys.id,
            name: apiKeys.name,
            overlapExpiresAt: apiKeys.overlapExpiresAt,
            machineUserName: machineUsers.name,
            projectId: machineUsers.projectId,
          })
          .from(apiKeys)
          .innerJoin(machineUsers, eq(machineUsers.id, apiKeys.machineUserId))
          .where(
            and(
              lte(apiKeys.overlapExpiresAt, soon),
              gt(apiKeys.overlapExpiresAt, now),
              isNull(apiKeys.revokedAt),
              eq(apiKeys.overlapAlertSent, false)
            )
          )
      )

      for (const row of rows) {
        try {
          const jobs = await runOrgScopedJob(orgId, ALERT_JOB_NAME, async ({ tx }) => {
            const entries = await createOrgAdminNotificationEntries({
              orgId,
              tx,
              template: {
                templateId: 'machine_key.expiry',
                severity: 'warning',
                payload: {
                  keyId: row.id,
                  keyName: row.name,
                  machineUserName: row.machineUserName,
                  projectId: row.projectId,
                  reason: 'rotation_overlap_ending',
                  overlapExpiresAt: row.overlapExpiresAt?.toISOString() ?? null,
                },
              },
            })
            await tx.update(apiKeys).set({ overlapAlertSent: true }).where(eq(apiKeys.id, row.id))
            return entries
          })
          allJobs.push(...jobs)
        } catch (error) {
          logRowFailure(logger, orgId, row.id, error)
        }
      }
    } catch (error) {
      logOrgFailure(logger, orgId, error)
    }
  }

  await sendNotificationJobs(boss, allJobs)
}
