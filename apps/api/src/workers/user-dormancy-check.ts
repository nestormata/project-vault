import { and, eq, isNull, or, sql } from 'drizzle-orm'
import { organizations, orgMemberships, userIdentityTokens } from '@project-vault/db/schema'
import { OperationalEvent } from '@project-vault/shared'
import type { BossService } from '../lib/boss.js'
import { fetchAllOrgIds, runOrgScopedJob } from '../middleware/rls.js'
import { resolveUserDormancyRecipients } from '../modules/notifications/routing.js'
import {
  createOrgAdminNotificationEntries,
  sendNotificationJobs,
  type NotificationQueueJob,
} from '../notifications/dispatcher.js'
import { operationalLog, serializeLogError } from '../lib/logger.js'
import type { WorkerLogger } from './expiry-alert-shared.js'

// This file is deliberately structured as a near-line-for-line mirror of
// machine-key-dormancy-check.ts (D1 below) and is therefore listed in .jscpd.json's ignore
// array, the same way apps/api/src/modules/audit/machine-entry.ts is exempted for the same
// "intentional structural template, not accidental copy-paste" reason.
const JOB_NAME = 'user:dormancy-check'

type DormantUserRow = {
  userId: string
  role: string
  lastActiveAt: Date | null
  createdAt: Date
  displayName: string
}

/**
 * Story 8.3 D1/AC-10/AC-11/AC-13 — daily job: for each org, flags every active org member whose
 * `org_memberships.lastActiveAt` (or `createdAt` if never active — AC-13) is older than that
 * org's configurable `user_dormancy_threshold_days` (default 90). Deliberately structured as a
 * line-for-line template of `machine-key-dormancy-check.ts` (D1): `fetchAllOrgIds()` →
 * `runOrgScopedJob()` per org → dedup via `INSERT ... ON CONFLICT DO NOTHING` against the new
 * partial unique index `idx_security_alerts_dormant_user` (D5) → `createOrgAdminNotification
 * Entries` + `sendNotificationJobs`. Differs from the machine-key job only in D12's routing
 * override (owner+admin union default, not the single-role default every other alert type uses).
 */
export async function runUserDormancyCheckJob(
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
          'user dormancy job org fetch failed',
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
    .select({ thresholdDays: organizations.userDormancyThresholdDays })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1)
  if (!org) return []

  const rows = await fetchDormantUsers(tx, orgId, org.thresholdDays)
  const jobs: NotificationQueueJob[] = []
  for (const row of rows) {
    const entries = await createDormancyAlertIfNew(tx, orgId, row)
    jobs.push(...entries)
  }
  return jobs
}

async function fetchDormantUsers(
  tx: Parameters<Parameters<typeof runOrgScopedJob>[2]>[0]['tx'],
  orgId: string,
  thresholdDays: number
): Promise<DormantUserRow[]> {
  // D4 — displayName is resolved via user_identity_tokens (never users.email), same rule this
  // story applies to the access report: a dormant-user alert generated for an already-
  // pseudonymized user must show the alias, not leak a real email into security_alerts.payload.
  return tx
    .select({
      userId: orgMemberships.userId,
      role: orgMemberships.role,
      lastActiveAt: orgMemberships.lastActiveAt,
      createdAt: orgMemberships.createdAt,
      displayName: userIdentityTokens.displayName,
    })
    .from(orgMemberships)
    .innerJoin(userIdentityTokens, eq(userIdentityTokens.userId, orgMemberships.userId))
    .where(
      and(
        eq(orgMemberships.orgId, orgId),
        eq(orgMemberships.status, 'active'),
        or(
          and(
            sql`${orgMemberships.lastActiveAt} IS NOT NULL`,
            sql`${orgMemberships.lastActiveAt} < now() - (${thresholdDays} || ' days')::interval`
          ),
          and(
            isNull(orgMemberships.lastActiveAt),
            sql`${orgMemberships.createdAt} < now() - (${thresholdDays} || ' days')::interval`
          )
        )
      )
    )
}

/**
 * Inserts a `user.dormant` security_alerts row and queues the notification, unless a
 * non-dismissed alert for this exact user already exists (the partial unique index makes the
 * INSERT a safe no-op via ON CONFLICT DO NOTHING rather than a separate existence check).
 */
async function createDormancyAlertIfNew(
  tx: Parameters<Parameters<typeof runOrgScopedJob>[2]>[0]['tx'],
  orgId: string,
  row: DormantUserRow
): Promise<NotificationQueueJob[]> {
  const payload = {
    userId: row.userId,
    displayName: row.displayName,
    orgRole: row.role,
    lastActiveAt: row.lastActiveAt?.toISOString() ?? null,
  }

  // Fix (code review): ON CONFLICT target must match the (org_id, payload->>'userId') index
  // exactly (see security-alerts.ts) — a user shared across orgs (D9) must be independently
  // dedupable per org, not globally by userId alone.
  const inserted = (await tx.execute(sql`
    INSERT INTO security_alerts (org_id, alert_type, severity, payload, status)
    VALUES (${orgId}, 'user.dormant', 'warning', ${JSON.stringify(payload)}::jsonb, 'PENDING_DELIVERY')
    ON CONFLICT (org_id, (payload->>'userId')) WHERE alert_type = 'user.dormant' AND status != 'dismissed'
    DO NOTHING
    RETURNING id
  `)) as unknown as { length: number }
  if (inserted.length === 0) return []

  // D12/AC-16 — the only place this job diverges from machine-key-dormancy-check.ts's template:
  // resolve recipients via the owner+admin-union default (unless the org has configured an
  // explicit override), rather than createOrgAdminNotificationEntries' own single-role default.
  const recipientUserIds = await resolveUserDormancyRecipients(orgId, tx)

  return createOrgAdminNotificationEntries({
    orgId,
    tx,
    template: { templateId: 'user.dormant', severity: 'warning', payload },
    recipientUserIds,
  })
}
