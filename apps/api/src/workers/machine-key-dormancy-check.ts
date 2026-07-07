import { and, eq, isNull, or, sql } from 'drizzle-orm'
import { apiKeys, machineUsers, organizations } from '@project-vault/db/schema'
import { OperationalEvent } from '@project-vault/shared'
import type { BossService } from '../lib/boss.js'
import { fetchAllOrgIds, runOrgScopedJob } from '../middleware/rls.js'
import {
  createOrgAdminNotificationEntries,
  sendNotificationJobs,
  type NotificationQueueJob,
} from '../notifications/dispatcher.js'
import { operationalLog, serializeLogError } from '../lib/logger.js'
import type { WorkerLogger } from './expiry-alert-shared.js'

const JOB_NAME = 'machine-key/dormancy-check'

type DormantKeyRow = {
  id: string
  machineUserId: string
  name: string
  lastUsedAt: Date | null
  projectId: string
  machineUserName: string
}

/**
 * Story 7.2 AC-21/D8/D9 — daily job: for each org, flags every non-revoked, non-snoozed
 * machine-user API key whose `lastUsedAt` (or `createdAt` if never used) is older than that
 * org's configurable `machine_key_dormancy_threshold_days` (default 90). Dedupe against a
 * previous, still-active `machine_key.dormant` alert for the same key uses a raw
 * `INSERT ... ON CONFLICT ... DO NOTHING` against the partial unique index
 * `idx_security_alerts_dormant_key` (AC-1) rather than a separate SELECT-then-INSERT, closing the
 * same TOCTOU window Story 4.4's rotation guard already discusses.
 */
export async function runMachineKeyDormancyCheckJob(
  boss: BossService,
  logger?: WorkerLogger
): Promise<void> {
  const orgIds = await fetchAllOrgIds()
  const allJobs: NotificationQueueJob[] = []

  for (const orgId of orgIds) {
    try {
      const jobs = await runOrgScopedJob(orgId, JOB_NAME, (ctx) => processOrg(ctx.tx, orgId))
      allJobs.push(...jobs)
    } catch (error) {
      if (logger) {
        operationalLog(
          logger,
          'error',
          OperationalEvent.MONITORING_EXPIRY_ALERT_ROW_FAILED,
          'machine key dormancy job org fetch failed',
          { orgId, assetId: 'n/a', err: serializeLogError(error) }
        )
      }
    }
  }

  await sendNotificationJobs(boss, allJobs)
}

async function processOrg(
  tx: Parameters<Parameters<typeof runOrgScopedJob>[2]>[0]['tx'],
  orgId: string
): Promise<NotificationQueueJob[]> {
  const [org] = await tx
    .select({ thresholdDays: organizations.machineKeyDormancyThresholdDays })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1)
  if (!org) return []

  const rows = await fetchDormantKeys(tx, orgId, org.thresholdDays)
  const jobs: NotificationQueueJob[] = []
  for (const row of rows) {
    const entries = await createDormancyAlertIfNew(tx, orgId, row)
    jobs.push(...entries)
  }
  return jobs
}

async function fetchDormantKeys(
  tx: Parameters<Parameters<typeof runOrgScopedJob>[2]>[0]['tx'],
  orgId: string,
  thresholdDays: number
): Promise<DormantKeyRow[]> {
  return tx
    .select({
      id: apiKeys.id,
      machineUserId: apiKeys.machineUserId,
      name: apiKeys.name,
      lastUsedAt: apiKeys.lastUsedAt,
      projectId: machineUsers.projectId,
      machineUserName: machineUsers.name,
    })
    .from(apiKeys)
    .innerJoin(machineUsers, eq(machineUsers.id, apiKeys.machineUserId))
    .where(
      and(
        eq(apiKeys.orgId, orgId),
        isNull(apiKeys.revokedAt),
        or(
          and(
            sql`${apiKeys.lastUsedAt} IS NOT NULL`,
            sql`${apiKeys.lastUsedAt} < now() - (${thresholdDays} || ' days')::interval`
          ),
          and(
            isNull(apiKeys.lastUsedAt),
            sql`${apiKeys.createdAt} < now() - (${thresholdDays} || ' days')::interval`
          )
        ),
        or(isNull(apiKeys.dormancySnoozedUntil), sql`${apiKeys.dormancySnoozedUntil} < now()`)
      )
    )
}

/**
 * Inserts a `machine_key.dormant` security_alerts row and queues the notification, unless a
 * non-dismissed alert for this exact key already exists (the partial unique index makes the
 * INSERT a safe no-op via ON CONFLICT DO NOTHING rather than a separate existence check).
 */
async function createDormancyAlertIfNew(
  tx: Parameters<Parameters<typeof runOrgScopedJob>[2]>[0]['tx'],
  orgId: string,
  row: DormantKeyRow
): Promise<NotificationQueueJob[]> {
  const payload = {
    keyId: row.id,
    machineUserId: row.machineUserId,
    machineUserName: row.machineUserName,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    projectId: row.projectId,
    keyName: row.name,
  }

  const inserted = (await tx.execute(sql`
    INSERT INTO security_alerts (org_id, alert_type, severity, payload, status)
    VALUES (${orgId}, 'machine_key.dormant', 'warning', ${JSON.stringify(payload)}::jsonb, 'PENDING_DELIVERY')
    ON CONFLICT ((payload->>'keyId')) WHERE alert_type = 'machine_key.dormant' AND status != 'dismissed'
    DO NOTHING
    RETURNING id
  `)) as unknown as { length: number }
  if (inserted.length === 0) return []

  return createOrgAdminNotificationEntries({
    orgId,
    tx,
    template: { templateId: 'machine_key.dormant', severity: 'warning', payload },
  })
}
