import type { FastifyBaseLogger } from 'fastify'
import { withOrg } from '@project-vault/db'
import type { BossService } from '../lib/boss.js'
import {
  clearThresholdAlertEpisode,
  upsertThresholdAlert,
  type ThresholdPct,
} from '../lib/threshold-alerts.js'
import {
  createOrgAdminNotificationEntries,
  sendNotificationJobs,
} from '../notifications/dispatcher.js'
import { resolveResourceUsage } from '../modules/platform-admin/service.js'

type WorkerLogger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>

const ORGS_NEAR_LIMIT_ALERT_TYPE = 'resource.orgs_near_limit'
const USERS_NEAR_LIMIT_ALERT_TYPE = 'resource.users_near_limit'

function thresholdFor(pct: number): ThresholdPct | null {
  if (pct >= 95) return 95
  if (pct >= 90) return 90
  if (pct >= 80) return 80
  return null
}

/**
 * Story 9.2 AC-14: instance-wide `orgs` count threshold — no single org to route this to (it is
 * instance-wide, D7), so it is recorded platform-side only (admin_alerts), no email/Slack fan-out.
 */
async function checkOrgsNearLimit(current: number, limit: number | null): Promise<void> {
  if (!limit) return
  const pct = (current / limit) * 100
  const thresholdPct = thresholdFor(pct)
  if (!thresholdPct) {
    await clearThresholdAlertEpisode(ORGS_NEAR_LIMIT_ALERT_TYPE, null)
    return
  }
  await upsertThresholdAlert({
    alertType: ORGS_NEAR_LIMIT_ALERT_TYPE,
    thresholdPct,
    severity: thresholdPct === 95 ? 'critical' : 'warning',
    payload: { current, limit, thresholdPct },
    scopeKey: null,
  })
}

/**
 * Story 9.2 AC-13: per-org `usersPerOrg` threshold — advisory-only (D3, does not block new
 * members), delivered to that specific org's `resource.users_near_limit`-routed recipients via
 * the existing per-org routing pipeline (Story 3.2).
 */
async function checkUsersNearLimitForOrg(
  boss: BossService,
  org: { orgId: string; current: number; limit: number | null }
): Promise<void> {
  if (!org.limit) return
  const pct = (org.current / org.limit) * 100
  const thresholdPct = thresholdFor(pct)
  if (!thresholdPct) {
    await clearThresholdAlertEpisode(USERS_NEAR_LIMIT_ALERT_TYPE, org.orgId)
    return
  }
  const severity = thresholdPct === 95 ? 'critical' : 'warning'
  const payload = { current: org.current, limit: org.limit, thresholdPct }
  const alert = await upsertThresholdAlert({
    alertType: USERS_NEAR_LIMIT_ALERT_TYPE,
    thresholdPct,
    severity,
    payload,
    scopeKey: org.orgId,
  })
  if (!alert) return

  const jobs = await withOrg(org.orgId, (tx) =>
    createOrgAdminNotificationEntries({
      orgId: org.orgId,
      tx,
      template: { templateId: USERS_NEAR_LIMIT_ALERT_TYPE, severity, payload },
    })
  )
  await sendNotificationJobs(boss, jobs)
}

/**
 * Story 9.2 AC-13/AC-14: hourly `resource-usage:check` job — evaluates instance-wide `orgs` count
 * and every org's `usersPerOrg` against instancePolicy limits, at 80/90/95% tiers (idempotent per
 * threshold+scope via upsertThresholdAlert).
 */
export async function runResourceUsageCheck(
  boss: BossService,
  _logger?: WorkerLogger
): Promise<void> {
  const usage = await resolveResourceUsage()
  await checkOrgsNearLimit(usage.orgs.current, usage.orgs.limit)
  for (const org of usage.usersPerOrg) {
    await checkUsersNearLimitForOrg(boss, org)
  }
}
