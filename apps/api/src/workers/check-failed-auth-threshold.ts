import { sql } from 'drizzle-orm'
import { getDb, withOrg, type Tx } from '@project-vault/db'
import {
  auditLogEntries,
  orgMemberships,
  organizations,
  securityAlerts,
} from '@project-vault/db/schema'
import { env } from '../config/env.js'
import { currentAuditKeyVersion } from '../modules/audit/key-version.js'
import { computeAuditHmac } from '../modules/audit/write-entry.js'
import { getAuditKey } from '../modules/vault/key-service.js'

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

async function activeOrgForUser(userId: string): Promise<string | null> {
  const orgRows = await getDb().select({ orgId: organizations.id }).from(organizations)
  for (const { orgId } of orgRows) {
    const memberships = await withOrg(orgId, (tx) =>
      tx
        .select({ orgId: orgMemberships.orgId })
        .from(orgMemberships)
        .where(
          sql`${orgMemberships.userId} = ${userId}::uuid AND ${orgMemberships.status} = 'active'`
        )
        .limit(1)
    )
    if (memberships[0]) return orgId
  }
  return null
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

async function findIpBreaches(windowStart: Date): Promise<Breach[]> {
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
    const orgIds = new Set<string>()
    for (const userRow of userRows) {
      const orgId = await activeOrgForUser(userRow.user_id)
      if (orgId) orgIds.add(orgId)
    }
    if (orgIds.size === 0) {
      process.stdout.write(
        `${JSON.stringify({ eventType: 'security.failed_auth_threshold_no_org', thresholdType: 'ip', ipAddress: row.key })}\n`
      )
    }
    for (const orgId of orgIds) {
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

async function findAccountBreaches(windowStart: Date): Promise<Breach[]> {
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
    const orgId = await activeOrgForUser(row.key)
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
            AND payload->>'ipAddress' = ${breach.ipAddress}
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

async function insertAuditRow(
  tx: Tx,
  orgId: string,
  alertId: string,
  payload: ReturnType<typeof payloadFor>
): Promise<void> {
  const keyVersion = await currentAuditKeyVersion(tx)
  const auditPayload = {
    alertId,
    thresholdType: payload.thresholdType,
    attemptCount: payload.attemptCount,
    windowSeconds: payload.windowSeconds,
  }
  const hmac = computeAuditHmac(
    {
      orgId,
      actorTokenId: null,
      actorType: 'system',
      eventType: ALERT_TYPE,
      payload: auditPayload,
      keyVersion,
    },
    getAuditKey()
  )
  await tx.insert(auditLogEntries).values({
    orgId,
    actorTokenId: null,
    actorType: 'system',
    eventType: ALERT_TYPE,
    payload: auditPayload,
    keyVersion,
    hmac,
  })
}

async function createAlertIfNeeded(
  breach: Breach,
  windowStart: Date,
  windowEnd: Date
): Promise<void> {
  await withOrg(breach.orgId, async (tx) => {
    if (await existingAlert(tx, breach, windowStart)) return
    const payload = payloadFor(breach, windowStart, windowEnd)
    const [alert] = await tx
      .insert(securityAlerts)
      .values({
        orgId: breach.orgId,
        alertType: ALERT_TYPE,
        severity: 'critical',
        status: 'PENDING_DELIVERY',
        payload,
      })
      .returning({ id: securityAlerts.id })
    if (!alert) return
    await insertAuditRow(tx, breach.orgId, alert.id, payload)
    process.stdout.write(
      `${JSON.stringify({ eventType: 'alert.pending_epic3', alertType: ALERT_TYPE, orgId: breach.orgId, thresholdType: breach.thresholdType, ipAddress: breach.ipAddress })}\n`
    )
  })
}

export async function runFailedAuthThresholdCheck(): Promise<void> {
  const windowEnd = new Date()
  const windowStart = new Date(
    windowEnd.getTime() - env.FAILED_AUTH_THRESHOLD_WINDOW_SECONDS * 1000
  )
  const breaches = [
    ...(await findIpBreaches(windowStart)),
    ...(await findAccountBreaches(windowStart)),
  ]
  for (const breach of breaches) {
    await createAlertIfNeeded(breach, windowStart, windowEnd)
  }
}

export async function checkFailedAuthThresholdHandler(): Promise<void> {
  try {
    await runFailedAuthThresholdCheck()
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ eventType: 'job.failed', job: 'security:check-failed-auth-threshold', error: error instanceof Error ? error.message : String(error) })}\n`
    )
    throw error
  }
}
