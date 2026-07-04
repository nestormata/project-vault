import { and, eq, sql } from 'drizzle-orm'
import { getDb, withOrg, type Tx } from '@project-vault/db'
import { orgMemberships, securityAlerts } from '@project-vault/db/schema'
import { env } from '../config/env.js'
import { failedAuthThresholdPayloadSchema } from '../modules/org/schema.js'
import { fetchAllOrgIds, runOrgScopedJob } from '../middleware/rls.js'
import {
  enqueueSecurityAlertNotification,
  sendNotificationJobs,
} from '../notifications/dispatcher.js'
import type { BossService } from '../lib/boss.js'
import { writeSystemAuditRow } from '../lib/system-audit-row.js'

const ALERT_TYPE = 'security.failed_auth_threshold'

type ThresholdType = 'ip' | 'account'
type Breach = {
  orgId: string
  thresholdType: ThresholdType
  attemptCount: number
  ipAddress?: string
  userId?: string
}

type CountRow = { key: string; attempt_count: string | number }
type UserRow = { user_id: string }

// RLS forces org_memberships lookups to run per-org (no cross-org query is possible
// through the app role) — see Story 1.9 Dev Agent Record. Returns ALL active orgs for
// the user, not just the first match, so a multi-org user's breach alerts every org.
async function activeOrgsForUser(orgIds: string[], userId: string): Promise<string[]> {
  const matches: string[] = []
  for (const orgId of orgIds) {
    const memberships = await withOrg(orgId, (tx) =>
      tx
        .select({ orgId: orgMemberships.orgId })
        .from(orgMemberships)
        .where(and(eq(orgMemberships.userId, userId), eq(orgMemberships.status, 'active')))
        .limit(1)
    )
    if (memberships[0]) matches.push(orgId)
  }
  return matches
}

function payloadFor(breach: Breach, windowStart: Date, windowEnd: Date) {
  return {
    thresholdType: breach.thresholdType,
    thresholdCount: env.FAILED_AUTH_THRESHOLD_COUNT,
    windowSeconds: env.FAILED_AUTH_THRESHOLD_WINDOW_SECONDS,
    attemptCount: breach.attemptCount,
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    ...(breach.ipAddress ? { ipAddress: breach.ipAddress } : {}),
    ...(breach.userId ? { userId: breach.userId } : {}),
  }
}

async function findIpBreaches(orgIds: string[], windowStart: Date): Promise<Breach[]> {
  const windowStartIso = windowStart.toISOString()
  const rows = await getDb().execute<CountRow>(sql`
    SELECT ip_address::text AS key, COUNT(*)::text AS attempt_count
    FROM failed_auth_attempts
    WHERE attempted_at >= ${windowStartIso}::timestamptz
    GROUP BY ip_address
    HAVING COUNT(*) >= ${env.FAILED_AUTH_THRESHOLD_COUNT}
  `)
  const breaches: Breach[] = []
  for (const row of rows) {
    const userRows = await getDb().execute<UserRow>(sql`
      SELECT DISTINCT user_id::text AS user_id
      FROM failed_auth_attempts faa
      WHERE faa.attempted_at >= ${windowStartIso}::timestamptz
        AND faa.ip_address = ${row.key}::inet
        AND faa.user_id IS NOT NULL
    `)
    const orgIdsForIp = new Set<string>()
    for (const userRow of userRows) {
      for (const orgId of await activeOrgsForUser(orgIds, userRow.user_id)) {
        orgIdsForIp.add(orgId)
      }
    }
    if (orgIdsForIp.size === 0) {
      process.stdout.write(
        `${JSON.stringify({ eventType: 'security.failed_auth_threshold_no_org', thresholdType: 'ip', ipAddress: row.key })}\n`
      )
    }
    for (const orgId of orgIdsForIp) {
      breaches.push({
        orgId,
        thresholdType: 'ip',
        ipAddress: row.key,
        attemptCount: Number(row.attempt_count),
      })
    }
  }
  return breaches
}

async function findAccountBreaches(orgIds: string[], windowStart: Date): Promise<Breach[]> {
  const windowStartIso = windowStart.toISOString()
  const rows = await getDb().execute<CountRow>(sql`
    SELECT user_id::text AS key, COUNT(*)::text AS attempt_count
    FROM failed_auth_attempts
    WHERE attempted_at >= ${windowStartIso}::timestamptz
      AND user_id IS NOT NULL
    GROUP BY user_id
    HAVING COUNT(*) >= ${env.FAILED_AUTH_THRESHOLD_COUNT}
  `)
  const breaches: Breach[] = []
  for (const row of rows) {
    // v1 single-org assumption (spec AC-9): primary org is the first active membership.
    const [orgId] = await activeOrgsForUser(orgIds, row.key)
    if (!orgId) continue
    breaches.push({
      orgId,
      thresholdType: 'account',
      userId: row.key,
      attemptCount: Number(row.attempt_count),
    })
  }
  return breaches
}

// AC-9b: account threshold by email when user_id is unknown. There is no org to
// attribute these to (failed_auth_attempts has no org_id and no resolvable user),
// so this only logs a platform-visible warning — never creates a security_alerts row.
async function logUnknownEmailAccountBreaches(windowStart: Date): Promise<void> {
  const windowStartIso = windowStart.toISOString()
  const rows = await getDb().execute<CountRow>(sql`
    SELECT lower(attempted_email) AS key, COUNT(*)::text AS attempt_count
    FROM failed_auth_attempts
    WHERE attempted_at >= ${windowStartIso}::timestamptz
      AND user_id IS NULL
    GROUP BY lower(attempted_email)
    HAVING COUNT(*) >= ${env.FAILED_AUTH_THRESHOLD_COUNT}
  `)
  for (const row of rows) {
    process.stdout.write(
      `${JSON.stringify({
        eventType: 'security.failed_auth_threshold_no_org',
        thresholdType: 'account',
        attemptedEmail: row.key,
        attemptCount: Number(row.attempt_count),
      })}\n`
    )
  }
}

async function existingAlert(tx: Tx, breach: Breach, windowStart: Date): Promise<boolean> {
  const windowStartIso = windowStart.toISOString()
  const rows =
    breach.thresholdType === 'ip'
      ? await tx.execute(sql`
          SELECT id
          FROM security_alerts
          WHERE org_id = ${breach.orgId}
            AND alert_type = ${ALERT_TYPE}
            AND created_at >= ${windowStartIso}::timestamptz
            AND payload->>'thresholdType' = ${breach.thresholdType}
            AND (payload->>'ipAddress')::inet = ${breach.ipAddress}::inet
          LIMIT 1
        `)
      : await tx.execute(sql`
          SELECT id
          FROM security_alerts
          WHERE org_id = ${breach.orgId}
            AND alert_type = ${ALERT_TYPE}
            AND created_at >= ${windowStartIso}::timestamptz
            AND payload->>'thresholdType' = ${breach.thresholdType}
            AND payload->>'userId' = ${breach.userId}
          LIMIT 1
        `)
  return rows.length > 0
}

function dedupLockKey(breach: Breach): string {
  const identity = breach.thresholdType === 'ip' ? breach.ipAddress : breach.userId
  return `${breach.orgId}:${ALERT_TYPE}:${breach.thresholdType}:${identity ?? ''}`
}

async function createAlertIfNeeded(
  breach: Breach,
  windowStart: Date,
  windowEnd: Date,
  boss: BossService
): Promise<void> {
  const queueIds = await runOrgScopedJob(
    breach.orgId,
    'security/check-failed-auth-threshold',
    async ({ tx }) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${dedupLockKey(breach)}))`)
      if (await existingAlert(tx, breach, windowStart)) return []
      const payload = failedAuthThresholdPayloadSchema.parse(
        payloadFor(breach, windowStart, windowEnd)
      )
      const [alert] = await tx
        .insert(securityAlerts)
        .values({
          orgId: breach.orgId,
          alertType: ALERT_TYPE,
          severity: 'critical',
          status: 'delivered',
          payload,
        })
        .returning({ id: securityAlerts.id })
      if (!alert) return []

      await writeSystemAuditRow(tx, {
        orgId: breach.orgId,
        eventType: ALERT_TYPE,
        payload: {
          alertId: alert.id,
          thresholdType: payload.thresholdType,
          attemptCount: payload.attemptCount,
          windowSeconds: payload.windowSeconds,
        },
      })

      const ids = await enqueueSecurityAlertNotification({
        orgId: breach.orgId,
        templateId: ALERT_TYPE,
        payload,
        severity: 'critical',
        tx,
      })

      process.stdout.write(
        `${JSON.stringify({ eventType: 'security.failed_auth_threshold.notification_enqueued', alertType: ALERT_TYPE, orgId: breach.orgId, thresholdType: breach.thresholdType })}\n`
      )
      return ids
    }
  )
  await sendNotificationJobs(boss, queueIds)
}

export async function runFailedAuthThresholdCheck(boss: BossService): Promise<void> {
  const windowEnd = new Date()
  const windowStart = new Date(
    windowEnd.getTime() - env.FAILED_AUTH_THRESHOLD_WINDOW_SECONDS * 1000
  )
  const orgIds = await fetchAllOrgIds()
  const breaches = [
    ...(await findIpBreaches(orgIds, windowStart)),
    ...(await findAccountBreaches(orgIds, windowStart)),
  ]
  await logUnknownEmailAccountBreaches(windowStart)
  for (const breach of breaches) {
    await createAlertIfNeeded(breach, windowStart, windowEnd, boss)
  }
}

export async function checkFailedAuthThresholdHandler(boss: BossService): Promise<void> {
  try {
    await runFailedAuthThresholdCheck(boss)
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ eventType: 'job.failed', job: 'security/check-failed-auth-threshold', error: error instanceof Error ? error.message : String(error) })}\n`
    )
    throw error
  }
}
