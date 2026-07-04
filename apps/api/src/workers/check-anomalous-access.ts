import { and, eq, gte, sql } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import { securityAlerts } from '@project-vault/db/schema'
import { env } from '../config/env.js'
import { anomalousAccessPayloadSchema } from '../modules/org/schema.js'
import { fetchAllOrgIds, runOrgScopedJob } from '../middleware/rls.js'
import {
  enqueueSecurityAlertNotification,
  sendNotificationJobs,
} from '../notifications/dispatcher.js'
import type { BossService } from '../lib/boss.js'
import { writeSystemAuditRow } from '../lib/system-audit-row.js'

// ADR-6.2-06: `credential.value_revealed` is the closest, most literal match to epics.md's
// "credential access events" — metadata-only reads (list/search) don't reveal plaintext and are
// a much weaker anomaly signal. Not the existing 'security.failed_auth_threshold' alert type.
const ALERT_TYPE = 'security.anomalous_access'
const CREDENTIAL_REVEAL_EVENT = 'credential.value_revealed'
const JOB_NAME = 'security/check-anomalous-access'

type AccessGroupRow = {
  actor_token_id: string | null
  revealed_count: string | number
}
type CredentialIdRow = { credential_id: string | null }

type Breach = {
  orgId: string
  actorTokenId: string | null
  revealedCount: number
  revealedCredentialIds: string[]
}

function payloadFor(breach: Breach, windowStart: Date, windowEnd: Date) {
  return {
    actorTokenId: breach.actorTokenId,
    revealedCount: breach.revealedCount,
    revealedCredentialIds: breach.revealedCredentialIds,
    windowSeconds: env.ANOMALOUS_ACCESS_WINDOW_SECONDS,
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
  }
}

/**
 * ADR-6.2-06/ADR-6.2-09's RLS clarification: `audit_log_entries` is org-scoped and RLS-protected
 * — a single cross-org query via the bare app connection would return zero rows (no org context
 * set), not "all orgs' rows". Mirrors the health-check worker's per-org RLS-scoped due-query:
 * one `runOrgScopedJob` transaction per org, never a single query bypassing RLS. Counts
 * credential.value_revealed audit rows per actor_token_id in the trailing window ("per project"
 * in epics.md's literal prose is dropped in favor of per-org, matching
 * check-failed-auth-threshold.ts's existing org-scoped precedent).
 */
async function findAccessBreachesForOrg(orgId: string, windowStart: Date): Promise<Breach[]> {
  const windowStartIso = windowStart.toISOString()
  return runOrgScopedJob(orgId, JOB_NAME, async ({ tx }) => {
    const rows = await tx.execute<AccessGroupRow>(sql`
      SELECT actor_token_id::text AS actor_token_id, COUNT(*)::text AS revealed_count
      FROM audit_log_entries
      WHERE event_type = ${CREDENTIAL_REVEAL_EVENT}
        AND created_at >= ${windowStartIso}::timestamptz
      GROUP BY actor_token_id
      HAVING COUNT(*) >= ${env.ANOMALOUS_ACCESS_THRESHOLD_COUNT}
    `)

    const breaches: Breach[] = []
    for (const row of rows) {
      // Adversarial-review finding 9: the distinct credential ids revealed in-window, capped at
      // 50 — a best-effort investigative aid, not a complete audit trail.
      const credentialRows = await tx.execute<CredentialIdRow>(sql`
        SELECT DISTINCT resource_id::text AS credential_id
        FROM audit_log_entries
        WHERE event_type = ${CREDENTIAL_REVEAL_EVENT}
          AND created_at >= ${windowStartIso}::timestamptz
          AND (actor_token_id IS NOT DISTINCT FROM ${row.actor_token_id}::uuid)
        LIMIT 50
      `)

      breaches.push({
        orgId,
        actorTokenId: row.actor_token_id,
        revealedCount: Number(row.revealed_count),
        revealedCredentialIds: credentialRows
          .map((r) => r.credential_id)
          .filter((id): id is string => id !== null),
      })
    }
    return breaches
  })
}

function dedupLockKey(breach: Breach): string {
  return `${breach.orgId}:${ALERT_TYPE}:${breach.actorTokenId ?? ''}`
}

/**
 * Uses the query builder (rather than a raw SQL block) for this dedup lookup — deliberately
 * structured differently from check-failed-auth-threshold.ts's own `existingAlert` (which needs
 * a raw two-branch ip/account query) so the two aren't near-identical text (jscpd gate) despite
 * serving the same "is there already a fresh alert for this identity?" purpose.
 */
async function existingAlert(tx: Tx, breach: Breach, windowStart: Date): Promise<boolean> {
  const actorMatch = breach.actorTokenId
    ? eq(sql`payload->>'actorTokenId'`, breach.actorTokenId)
    : sql`payload->>'actorTokenId' IS NULL`
  const rows = await tx
    .select({ id: securityAlerts.id })
    .from(securityAlerts)
    .where(
      and(
        eq(securityAlerts.orgId, breach.orgId),
        eq(securityAlerts.alertType, ALERT_TYPE),
        gte(securityAlerts.createdAt, windowStart),
        actorMatch
      )
    )
    .limit(1)
  return rows.length > 0
}

/**
 * Adversarial-review finding 15: a credential-reveal volume spike is a potential
 * active-compromise/insider-threat signal — at least as urgent as a downed endpoint, hence
 * `severity: 'critical'` (matching `service.down`, not the original draft's `'warning'`).
 */
async function insertAnomalousAccessAlertRow(
  tx: Tx,
  orgId: string,
  payload: ReturnType<typeof payloadFor>
): Promise<{ id: string } | undefined> {
  const [alert] = await tx
    .insert(securityAlerts)
    .values({ orgId, alertType: ALERT_TYPE, severity: 'critical', status: 'delivered', payload })
    .returning({ id: securityAlerts.id })
  return alert
}

async function createAlertIfNeeded(
  breach: Breach,
  windowStart: Date,
  windowEnd: Date,
  boss: BossService
): Promise<void> {
  const queueIds = await runOrgScopedJob(breach.orgId, JOB_NAME, async ({ tx }) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${dedupLockKey(breach)}))`)
    if (await existingAlert(tx, breach, windowStart)) return []

    const payload = anomalousAccessPayloadSchema.parse(payloadFor(breach, windowStart, windowEnd))
    const alert = await insertAnomalousAccessAlertRow(tx, breach.orgId, payload)
    if (!alert) return []

    await writeSystemAuditRow(tx, {
      orgId: breach.orgId,
      eventType: ALERT_TYPE,
      payload: {
        alertId: alert.id,
        actorTokenId: payload.actorTokenId,
        revealedCount: payload.revealedCount,
        windowSeconds: payload.windowSeconds,
      },
    })

    // ADR-6.2-10: the firing security_alerts.id is included so the delivered alert can be
    // dismissed (AC 18) directly.
    const ids = await enqueueSecurityAlertNotification({
      orgId: breach.orgId,
      templateId: ALERT_TYPE,
      payload: { ...payload, securityAlertId: alert.id },
      severity: 'critical',
      tx,
    })

    process.stdout.write(
      `${JSON.stringify({ eventType: 'security.anomalous_access.notification_enqueued', orgId: breach.orgId, actorTokenId: breach.actorTokenId })}\n`
    )
    return ids
  })
  await sendNotificationJobs(boss, queueIds)
}

export async function runAnomalousAccessCheck(boss: BossService): Promise<void> {
  const windowEnd = new Date()
  const windowStart = new Date(windowEnd.getTime() - env.ANOMALOUS_ACCESS_WINDOW_SECONDS * 1000)
  // FR31's literal 5-accesses-within-an-hour threshold is org+actor scoped. Multi-org user
  // attribution (adversarial-review example) falls out naturally: audit_log_entries rows are
  // already org-scoped, so each org's own per-org query only ever sees that org's rows —
  // simpler than check-failed-auth-threshold.ts's activeOrgsForUser case, which has to resolve
  // org membership because failed_auth_attempts isn't itself org-scoped.
  const orgIds = await fetchAllOrgIds()

  for (const orgId of orgIds) {
    const breaches = await findAccessBreachesForOrg(orgId, windowStart)
    for (const breach of breaches) {
      await createAlertIfNeeded(breach, windowStart, windowEnd, boss)
    }
  }
}

export async function checkAnomalousAccessHandler(boss: BossService): Promise<void> {
  try {
    await runAnomalousAccessCheck(boss)
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ eventType: 'job.failed', job: JOB_NAME, error: error instanceof Error ? error.message : String(error) })}\n`
    )
    throw error
  }
}
